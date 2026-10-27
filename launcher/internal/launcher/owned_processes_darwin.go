//go:build darwin

package launcher

import (
	"bytes"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
	"unsafe"
)

const processOwnerVariable = "JOBCTRL_PROCESS_OWNER"

type ownedProcess struct {
	PID                                       int
	ParentPID                                 int
	Identity                                  string
	owner, stateDir, payloadRoot, runtimeMode string
}

func processOwner(ctx launchContext) string {
	sum := sha256.Sum256([]byte(ctx.Instance.ID + "\x00" + ctx.Instance.RuntimeHome + "\x00" + ctx.Instance.StateDir))
	return hex.EncodeToString(sum[:])
}

// Stamp every native launch, including direct Python commands. External SDK
// and browser children inherit this instance-specific value through fork/exec.
// No command-line spelling or process-name match grants termination authority.
func ownedProcessEnvironment(ctx launchContext) []string {
	if ctx.Instance.ID == "" || ctx.Instance.StateDir == "" {
		return append([]string{}, ctx.Environment...)
	}
	env := make([]string, 0, len(ctx.Environment)+1)
	for _, pair := range ctx.Environment {
		if !strings.HasPrefix(pair, processOwnerVariable+"=") {
			env = append(env, pair)
		}
	}
	return append(env, processOwnerVariable+"="+processOwner(ctx))
}

func processIdentityFromBSD(info []byte) string {
	pid := binary.LittleEndian.Uint32(info[procBSDPIDOffset:])
	seconds := binary.LittleEndian.Uint64(info[procBSDStartSeconds:])
	micros := binary.LittleEndian.Uint64(info[procBSDStartMicrosecond:])
	return fmt.Sprintf("%d:%d:%d", pid, seconds, micros)
}

// PROC_UID_ONLY returns only this account's PIDs. Size and population can
// change between calls; grow and retry rather than accept a truncated census.
func userProcessIDs() ([]int, error) {
	for size := 4096; size <= 1<<20; size *= 2 {
		buffer := make([]byte, size)
		n, _, errno := syscall.Syscall6(syscall.SYS_PROC_INFO, 1, 4, uintptr(os.Getuid()), 0, uintptr(unsafe.Pointer(&buffer[0])), uintptr(size))
		if errno != 0 {
			return nil, errno
		}
		if int(n) >= size {
			continue
		}
		if n%4 != 0 {
			return nil, errors.New("invalid kernel process census")
		}
		pids := make([]int, 0, int(n)/4)
		for off := 0; off < int(n); off += 4 {
			if pid := int(binary.LittleEndian.Uint32(buffer[off:])); pid > 0 {
				pids = append(pids, pid)
			}
		}
		return pids, nil
	}
	return nil, errors.New("kernel process census exceeded its bound")
}

// Inspect only ownership fields. Arguments and other environment values are
// never returned, persisted, printed, or included in errors.
var processArgumentBuffers = sync.Pool{New: func() any { return make([]byte, 2<<20) }}

func readProcessScope(pid int) (ownedProcess, error) {
	var p ownedProcess
	before, err := procInfo(pid, procPIDTBSDInfo, procBSDInfoSize)
	if err != nil {
		return p, err
	}
	if int(binary.LittleEndian.Uint32(before[20:])) != os.Getuid() {
		return p, syscall.ESRCH
	}
	if binary.LittleEndian.Uint32(before[4:]) == 5 {
		return p, syscall.ESRCH
	} // zombie cannot write or fork
	p.PID, p.ParentPID, p.Identity = pid, int(binary.LittleEndian.Uint32(before[16:])), processIdentityFromBSD(before)
	mib := [3]int32{1, 49, int32(pid)} // CTL_KERN, KERN_PROCARGS2
	argmax, err := syscall.SysctlUint32("kern.argmax")
	if err != nil {
		return p, err
	}
	if argmax == 0 || argmax > 2<<20-4 {
		return p, errors.New("invalid kernel argument bound")
	}
	buffer := processArgumentBuffers.Get().([]byte)
	defer processArgumentBuffers.Put(buffer)
	buffer = buffer[:argmax+4]
	size := uintptr(len(buffer))
	_, _, errno := syscall.Syscall6(syscall.SYS___SYSCTL, uintptr(unsafe.Pointer(&mib[0])), 3, uintptr(unsafe.Pointer(&buffer[0])), uintptr(unsafe.Pointer(&size)), 0, 0)
	if errno != 0 {
		after, checkErr := procInfo(pid, procPIDTBSDInfo, procBSDInfoSize)
		if errors.Is(checkErr, syscall.ESRCH) || (checkErr == nil && (processIdentityFromBSD(after) != processIdentityFromBSD(before) || binary.LittleEndian.Uint32(after[4:]) == 5)) {
			return p, syscall.ESRCH
		}
		return p, errno
	}
	if size > uintptr(len(buffer)) || size < 4 {
		return p, errors.New("invalid kernel process argument size")
	}
	p.PID, p.ParentPID, p.Identity = pid, int(binary.LittleEndian.Uint32(before[16:])), processIdentityFromBSD(before)
	if err := decodeProcessScope(buffer[:size], &p); err != nil {
		return p, err
	}
	after, err := procInfo(pid, procPIDTBSDInfo, procBSDInfoSize)
	if err != nil {
		return p, err
	}
	if processIdentityFromBSD(after) != p.Identity {
		return p, syscall.ESRCH
	}
	return p, nil
}

func decodeProcessScope(raw []byte, p *ownedProcess) error {
	if len(raw) < 4 {
		return errors.New("incomplete kernel process arguments")
	}
	argc := int(binary.LittleEndian.Uint32(raw))
	raw = raw[4:]
	take := func() ([]byte, bool) {
		i := bytes.IndexByte(raw, 0)
		if i < 0 {
			return nil, false
		}
		value := raw[:i]
		raw = raw[i+1:]
		return value, true
	}
	if _, ok := take(); !ok {
		return errors.New("incomplete kernel executable path")
	}
	for len(raw) > 0 && raw[0] == 0 {
		raw = raw[1:]
	}
	if argc < 0 || argc > 1<<18 {
		return errors.New("invalid kernel argument count")
	}
	for i := 0; i < argc; i++ {
		if _, ok := take(); !ok {
			return errors.New("incomplete kernel argument vector")
		}
	}
	for len(raw) > 0 && raw[0] != 0 {
		pair, ok := take()
		if !ok {
			return errors.New("incomplete kernel environment")
		}
		key, value, ok := bytes.Cut(pair, []byte{'='})
		if !ok {
			continue
		}
		switch string(key) {
		case processOwnerVariable:
			p.owner = string(value)
		case "JOBCTRL_DIR":
			p.stateDir = string(value)
		case "JOBCTRL_PAYLOAD_DIR":
			p.payloadRoot = string(value)
		case "JOBCTRL_RUNTIME_MODE":
			p.runtimeMode = string(value)
		}
	}
	return nil
}

var inspectOwnedProcesses = discoverOwnedProcesses

func discoverOwnedProcesses(ctx launchContext, state instanceState) ([]ownedProcess, error) {
	pids, err := userProcessIDs()
	if err != nil {
		return nil, fmt.Errorf("enumerate process ownership: %w", err)
	}
	all := make(map[int]ownedProcess, len(pids))
	owned := map[int]bool{}
	inspectionErrors := map[int]error{}
	for _, pid := range pids {
		if pid == os.Getpid() {
			continue
		}
		p, err := readProcessScope(pid)
		if errors.Is(err, syscall.ESRCH) || errors.Is(err, syscall.ENOENT) {
			continue
		}
		if err != nil {
			// Other applications can exit or restrict argv while the census
			// runs. Keep their kernel ancestry; only an owned match below
			// can block this instance's cleanup.
			if p.PID == 0 {
				continue
			}
			inspectionErrors[pid] = err
		}
		all[pid] = p
		// Older native releases already exported these exact workspace and
		// payload bindings. This adopts their surviving detached children.
		legacy := p.runtimeMode == "bundled" && p.stateDir == ctx.Instance.StateDir && p.payloadRoot != "" && (p.payloadRoot == ctx.PayloadRoot || p.payloadRoot == state.PayloadRoot)
		if (ctx.Instance.ID != "" && p.owner == processOwner(ctx)) || legacy {
			owned[pid] = true
		}
	}
	for _, record := range append([]componentRecord{state.Supervisor}, componentRecords(state)...) {
		if p, ok := all[record.PID]; ok && p.Identity == record.StartIdentity && recordMatchesLiveProcess(record) {
			owned[p.PID] = true
		}
	}
	// Live ancestry supplements inherited ownership for a child whose SDK
	// deliberately replaced its environment. It never adopts another instance.
	for changed := true; changed; {
		changed = false
		for pid, p := range all {
			if !owned[pid] && owned[p.ParentPID] {
				owned[pid] = true
				changed = true
			}
		}
	}
	result := make([]ownedProcess, 0, len(owned))
	for pid := range owned {
		if err := inspectionErrors[pid]; err != nil {
			// A dying owned task can lose its address space immediately
			// before becoming a zombie. Recheck rather than report a false
			// permission/VM failure from that exit window.
			for attempt := 0; attempt < 3; attempt++ {
				time.Sleep(20 * time.Millisecond)
				p, retryErr := readProcessScope(pid)
				if errors.Is(retryErr, syscall.ESRCH) {
					delete(owned, pid)
					break
				}
				if retryErr == nil && p.Identity != all[pid].Identity {
					delete(owned, pid)
					break
				}
				if retryErr == nil {
					all[pid] = p
					delete(inspectionErrors, pid)
					break
				}
			}
			if !owned[pid] {
				continue
			}
			if err := inspectionErrors[pid]; err != nil {
				return nil, fmt.Errorf("inspect owned PID %d: %w", pid, err)
			}
		}
		result = append(result, all[pid])
	}
	return result, nil
}

func componentRecords(state instanceState) []componentRecord {
	records := make([]componentRecord, 0, len(state.Components))
	for _, record := range state.Components {
		records = append(records, record)
	}
	return records
}

func signalDiscoveredProcess(p ownedProcess, signal syscall.Signal) error {
	identity, err := processStartIdentity(p.PID)
	if errors.Is(err, syscall.ESRCH) {
		return nil
	}
	if err != nil {
		return err
	}
	if identity != p.Identity {
		return errors.New("process identity changed; signal refused")
	}
	if err := syscall.Kill(p.PID, signal); err != nil && !errors.Is(err, syscall.ESRCH) {
		return err
	}
	return nil
}

// Drain the whole instance after its supervisor's cooperative shutdown. A
// detached/reparented child remains discoverable; process groups are not the
// final proof. Repeat discovery across fork/exit races and verify zero writers.
func terminateOwnedProcesses(ctx launchContext, state instanceState) error {
	return drainOwnedProcesses(ctx, state, nil)
}

func drainOwnedProcesses(ctx launchContext, state instanceState, known []ownedProcess) error {
	deadline := time.Now().Add(shutdownTimeout)
	finalDeadline := deadline.Add(shutdownTimeout)
	tracked := make(map[int]ownedProcess, len(known))
	for _, p := range known {
		tracked[p.PID] = p
	}
	signaled := map[string]syscall.Signal{}
	for time.Now().Before(finalDeadline) {
		processes, err := inspectOwnedProcesses(ctx, state)
		if err != nil {
			return err
		}
		for _, p := range processes {
			tracked[p.PID] = p
		}
		signal := syscall.SIGTERM
		if time.Now().After(deadline) {
			signal = syscall.SIGKILL
		}
		for pid, p := range tracked {
			identity, err := processStartIdentity(pid)
			if errors.Is(err, syscall.ESRCH) || (err == nil && identity != p.Identity) {
				delete(tracked, pid)
				continue
			}
			if err != nil {
				return fmt.Errorf("verify owned PID %d: %w", pid, err)
			}
			info, err := procInfo(pid, procPIDTBSDInfo, procBSDInfoSize)
			if errors.Is(err, syscall.ESRCH) || (err == nil && binary.LittleEndian.Uint32(info[4:]) == 5) {
				delete(tracked, pid)
				continue
			}
			if err != nil {
				return err
			}
			if signaled[p.Identity] == signal {
				continue
			}
			if signal == syscall.SIGKILL {
				if err := signalDiscoveredProcess(p, syscall.SIGSTOP); err != nil {
					return fmt.Errorf("freeze owned PID %d: %w", pid, err)
				}
			}
			if err := signalDiscoveredProcess(p, signal); err != nil {
				return fmt.Errorf("terminate owned PID %d: %w", pid, err)
			}
			signaled[p.Identity] = signal
		}
		if len(tracked) == 0 && len(processes) == 0 {
			return nil
		}
		time.Sleep(50 * time.Millisecond)
	}
	remaining, err := inspectOwnedProcesses(ctx, state)
	if err != nil {
		return err
	}
	if len(remaining) == 0 && len(tracked) == 0 {
		return nil
	}
	pids := make([]string, 0, len(tracked))
	for pid := range tracked {
		pids = append(pids, strconv.Itoa(pid))
	}
	return fmt.Errorf("JobCtrl processes remain after termination (PIDs %s); stop those processes and retry", strings.Join(pids, ", "))
}
