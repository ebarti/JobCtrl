//go:build darwin

package launcher

import (
	"bytes"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"maps"
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
	CoalitionIDs                              [2]uint64
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
		if !strings.HasPrefix(pair, processOwnerVariable+"=") && !strings.HasPrefix(pair, "JOBCTRL_RUNTIME_HOME=") {
			env = append(env, pair)
		}
	}
	if ctx.Instance.RuntimeHome != "" {
		env = append(env, "JOBCTRL_RUNTIME_HOME="+ctx.Instance.RuntimeHome)
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
var readProcessOwnership = readProcessScope
var scopedProcessIDs = userProcessIDs
var executionProcessBSDInfo = processBSDInfoIncludingZombies

type executionWitnesses map[executionScope]struct{}

func discoverOwnedProcesses(ctx launchContext, state instanceState, witnesses ...executionWitnesses) ([]ownedProcess, error) {
	scopes, err := readOwnedExecutionScopes(ctx)
	if err != nil {
		return nil, err
	}
	if len(scopes) > 0 {
		return discoverScopedProcesses(ctx, state, scopes, witnesses...)
	}
	// Modern registries never fall back to historical PID records after the
	// execution receipts have been retired. Those PIDs may now be reused or
	// may have been invalid registry references from the start. Only a fresh
	// durable scope can grant authority over a later execution.
	if state.ExecutionScopeID != "" || state.OwnershipVerified {
		return nil, nil
	}
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
		p, err := readProcessOwnership(pid)
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
				p, retryErr := readProcessOwnership(pid)
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
		return nil
	} // original process exited; never adopt its replacement
	if p.CoalitionIDs != ([2]uint64{}) {
		ids, err := processCoalitionIDs(p.PID)
		if errors.Is(err, syscall.ESRCH) {
			return nil
		}
		if err != nil {
			return err
		}
		if ids != p.CoalitionIDs {
			return errors.New("process changed execution ownership; signal refused")
		}
		after, err := processStartIdentity(p.PID)
		if errors.Is(err, syscall.ESRCH) {
			return nil
		}
		if err != nil {
			return err
		}
		if after != p.Identity {
			return nil
		}
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
	return drainOwnedProcesses(ctx, state, nil, make(executionWitnesses))
}

func drainOwnedProcesses(ctx launchContext, state instanceState, known []ownedProcess, witnesses executionWitnesses) error {
	if err := drainScopedCommandRoots(ctx, state, witnesses); err != nil {
		return err
	}
	deadline := time.Now().Add(shutdownTimeout)
	finalDeadline := deadline.Add(shutdownTimeout)
	tracked := make(map[int]ownedProcess, len(known))
	for _, p := range known {
		tracked[p.PID] = p
	}
	signaled := map[string]syscall.Signal{}
	for time.Now().Before(finalDeadline) {
		processes, err := inspectOwnedProcesses(ctx, state, witnesses)
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
	remaining, err := inspectOwnedProcesses(ctx, state, witnesses)
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

func currentScopeTransportAlive(scope executionScope) (bool, error) {
	if scope.RootPID == os.Getpid() {
		return false, nil // The caller is already counted separately.
	}
	before, err := processBSDInfoIncludingZombies(scope.RootPID)
	if errors.Is(err, syscall.ESRCH) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	if binary.LittleEndian.Uint32(before[4:]) == 5 || processIdentityFromBSD(before) != scope.RootIdentity {
		return false, nil
	}
	ids, err := processCoalitionIDs(scope.RootPID)
	if errors.Is(err, syscall.ESRCH) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	after, err := processBSDInfoIncludingZombies(scope.RootPID)
	if errors.Is(err, syscall.ESRCH) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	if binary.LittleEndian.Uint32(after[4:]) == 5 || processIdentityFromBSD(after) != scope.RootIdentity {
		return false, nil
	}
	if ids != scope.CoalitionIDs {
		return false, errors.New("current execution transport changed coalition")
	}
	return true, nil
}

// A detached supervisor's parent waits for readiness before it can exit. It
// is transport only when its live birth, parent, executable and native scope
// match this exact command. Use the same identity in the count and PID census.
func currentScopeWaitingParent(ctx launchContext, scope executionScope) (ownedProcess, error) {
	readyFD, err := strconv.Atoi(environmentMap(ctx.Environment)["JOBCTRL_READY_FD"])
	if err != nil || readyFD < 3 {
		return ownedProcess{}, nil
	}
	pid := os.Getppid()
	before, err := processBSDInfoIncludingZombies(pid)
	if errors.Is(err, syscall.ESRCH) {
		return ownedProcess{}, nil
	}
	if err != nil {
		return ownedProcess{}, err
	}
	if binary.LittleEndian.Uint32(before[4:]) == 5 || int(binary.LittleEndian.Uint32(before[16:])) != scope.RootPID || int(binary.LittleEndian.Uint32(before[20:])) != os.Getuid() {
		return ownedProcess{}, nil
	}
	path, err := processExecutable(pid)
	if err != nil {
		return ownedProcess{}, err
	}
	if !sameExecutable(path, ctx.Executable) {
		return ownedProcess{}, nil
	}
	ids, err := processCoalitionIDs(pid)
	if err != nil {
		return ownedProcess{}, err
	}
	after, err := processBSDInfoIncludingZombies(pid)
	if err != nil {
		return ownedProcess{}, err
	}
	identity := processIdentityFromBSD(before)
	if os.Getppid() != pid || processIdentityFromBSD(after) != identity || binary.LittleEndian.Uint32(after[4:]) == 5 || int(binary.LittleEndian.Uint32(after[16:])) != scope.RootPID || int(binary.LittleEndian.Uint32(after[20:])) != os.Getuid() || ids != scope.CoalitionIDs {
		return ownedProcess{}, errors.New("detached startup transport changed identity")
	}
	return ownedProcess{PID: pid, ParentPID: scope.RootPID, Identity: identity, CoalitionIDs: ids}, nil
}

// The scope counter is atomic. In the current scope only the inspecting
// command and its exact verified transports may be excluded. Fence each live
// transport on both sides of the count so its exit cannot hide a successor.
func scopedTaskZero(ctx launchContext, scope executionScope, currentScope string, witnesses ...executionWitnesses) (bool, bool) {
	allowed := uint64(0)
	transport := false
	waitingParent := ownedProcess{}
	if scope.ID == currentScope {
		allowed = 1 // currentExecutionScope already authenticated the caller.
		var err error
		transport, err = currentScopeTransportAlive(scope)
		if err != nil {
			return false, false
		}
		if transport {
			allowed++
		}
		waitingParent, err = currentScopeWaitingParent(ctx, scope)
		if err != nil {
			return false, false
		}
		if waitingParent.PID != 0 {
			allowed++
		}
	}
	count, err := readCoalitionActiveTaskCount(scope.CoalitionIDs[0])
	if errors.Is(err, syscall.ESRCH) && scope.ID != currentScope {
		if len(witnesses) > 0 {
			if _, observed := witnesses[0][scope]; observed {
				return true, true
			}
		}
		// Only the exact same-boot completion made by a controller that
		// witnessed the scope can explain an already-reaped coalition.
		completion, completionErr := readExecutionCompletion(ctx, scope.ID)
		raw, marshalErr := json.Marshal(scope)
		if completionErr == nil && marshalErr == nil {
			expected := executionCompletionForReceipt(scope, append(raw, '\n'), scope.BootSession)
			exited, exitErr := waitExecutionRoot(scope.RootPID, scope.RootIdentity, 0)
			if exitErr == nil && exited && completion.Scope == scope && completion.ReceiptSHA256 == expected.ReceiptSHA256 && completion.VerificationBootSession == scope.BootSession {
				return true, true
			}
		}
	}
	if err != nil || count < allowed {
		return false, false
	}
	if scope.ID == currentScope {
		after, err := currentScopeTransportAlive(scope)
		if err != nil || transport != after {
			return false, false
		}
		waitingAfter, err := currentScopeWaitingParent(ctx, scope)
		if err != nil || waitingAfter != waitingParent {
			return false, false
		}
	}
	return count == allowed, true
}

// Kernel membership is the durable authority, even after all original parents
// exit, an exec clears the environment, or a child starts a new session.
func discoverScopedProcesses(ctx launchContext, state instanceState, scopes []executionScope, witnesses ...executionWitnesses) ([]ownedProcess, error) {
	boot, err := executionBootSession()
	if err != nil {
		return nil, err
	}
	wanted := map[[2]uint64]executionScope{}
	for _, scope := range scopes {
		if scope.BootSession == boot {
			wanted[scope.CoalitionIDs] = scope
		}
	}
	if len(wanted) == 0 {
		return nil, nil
	}
	currentScope, err := currentExecutionScope(ctx, scopes, boot)
	if err != nil {
		return nil, err
	}
	var previousEmpty map[int]executionProcessObservation
	var inspectionErr error
	for attempt := 0; attempt < 32; attempt++ {
		allZero, knownNonzero := true, false
		for _, scope := range wanted {
			zero, known := scopedTaskZero(ctx, scope, currentScope, witnesses...)
			if known && zero && scope.ID != currentScope && len(witnesses) > 0 && witnesses[0] != nil {
				witnesses[0][scope] = struct{}{}
			}
			if !known || !zero {
				allZero = false
			}
			if known && !zero {
				knownNonzero = true
			}
		}
		if allZero {
			return nil, nil
		}
		waitingParent := ownedProcess{}
		for _, scope := range scopes {
			if scope.ID == currentScope {
				waitingParent, err = currentScopeWaitingParent(ctx, scope)
				if err != nil {
					return nil, err
				}
				break
			}
		}
		members, inventory, complete, err := executionProcessInventory(scopedProcessIDs, processCoalitionIDs)
		result := make([]ownedProcess, 0)
		for _, member := range members {
			scope, owned := wanted[member.CoalitionIDs]
			if !owned {
				continue
			}
			// The helper is the current public start/CLI command's parent,
			// not a leftover of an earlier runtime generation.
			if scope.ID == currentScope && scope.RootPID == member.PID && scope.RootIdentity == member.Identity {
				continue
			}
			if scope.ID == currentScope && waitingParent.PID != 0 && member == waitingParent {
				continue
			}
			result = append(result, member)
		}
		if len(result) > 0 && (err == nil || knownNonzero) {
			// Each selected member is checked again before signalling. A
			// different uninspectable PID must not prevent cleanup, and the
			// scope counter still prevents an incomplete census proving zero.
			if len(witnesses) > 0 && witnesses[0] != nil {
				for _, member := range result {
					witnesses[0][wanted[member.CoalitionIDs]] = struct{}{}
				}
			}
			return result, nil
		}
		if err != nil && !knownNonzero {
			return nil, err
		}
		if knownNonzero {
			if err != nil {
				inspectionErr = err
			}
			previousEmpty = nil
			time.Sleep(25 * time.Millisecond)
		} else if complete {
			if previousEmpty != nil && maps.Equal(previousEmpty, inventory) {
				return result, nil
			}
			previousEmpty = inventory
		} else {
			previousEmpty = nil
		}
	}
	return nil, errors.Join(errors.New("process census changed repeatedly during cleanup; retry jobctrl stop"), inspectionErr)
}

// An empty PID sample is insufficient: an enumerated parent may fork and
// become a zombie before its first BSD read. Fence the real UID PID set, retain
// every inspected birth/state/coalition row, and require matching complete
// inventories across empty observations. Pre-existing zombies remain harmless.
type executionProcessObservation struct {
	Identity   string
	UID, State uint32
	ParentPID  int
	Coalitions [2]uint64
}

func executionProcessInventory(listPIDs func() ([]int, error), readCoalitions func(int) ([2]uint64, error)) ([]ownedProcess, map[int]executionProcessObservation, bool, error) {
	pids, err := listPIDs()
	if err != nil {
		return nil, nil, false, err
	}
	pidSet := make(map[int]bool, len(pids))
	inventory := make(map[int]executionProcessObservation, len(pids))
	members := make([]ownedProcess, 0)
	complete := true
	var inspectionErr error
	recordInspectionError := func(err error) {
		complete = false
		if inspectionErr == nil {
			inspectionErr = err
		}
	}
	for _, pid := range pids {
		pidSet[pid] = true
		if pid == os.Getpid() {
			continue
		}
		before, err := executionProcessBSDInfo(pid)
		if errors.Is(err, syscall.ESRCH) {
			complete = false
			continue
		}
		if err != nil {
			recordInspectionError(fmt.Errorf("inspect process identity for PID %d: %w", pid, err))
			continue
		}
		observation := executionProcessObservation{Identity: processIdentityFromBSD(before), UID: binary.LittleEndian.Uint32(before[20:]), State: binary.LittleEndian.Uint32(before[4:]), ParentPID: int(binary.LittleEndian.Uint32(before[16:]))}
		if observation.State != 5 {
			observation.State = 0 // Runnable/sleeping changes do not change liveness.
		}
		inventory[pid] = observation
		if int(observation.UID) != os.Getuid() || observation.State == 5 {
			continue
		}
		ids, coalitionErr := readCoalitions(pid)
		after, err := executionProcessBSDInfo(pid)
		if errors.Is(err, syscall.ESRCH) {
			complete = false
			continue
		}
		if err != nil {
			recordInspectionError(fmt.Errorf("reinspect process identity for PID %d: %w", pid, err))
			continue
		}
		if processIdentityFromBSD(after) != observation.Identity || binary.LittleEndian.Uint32(after[4:]) == 5 || binary.LittleEndian.Uint32(after[20:]) != observation.UID {
			complete = false
			continue
		}
		if errors.Is(coalitionErr, syscall.ESRCH) {
			complete = false
			continue
		}
		if coalitionErr != nil {
			recordInspectionError(fmt.Errorf("inspect execution ownership for PID %d: %w", pid, coalitionErr))
			continue
		}
		observation.State = 0
		observation.ParentPID = int(binary.LittleEndian.Uint32(after[16:]))
		observation.Coalitions = ids
		inventory[pid] = observation
		members = append(members, ownedProcess{PID: pid, ParentPID: observation.ParentPID, Identity: observation.Identity, CoalitionIDs: ids})
	}
	afterPIDs, err := listPIDs()
	if err != nil {
		return members, inventory, false, err
	}
	afterSet := make(map[int]bool, len(afterPIDs))
	for _, pid := range afterPIDs {
		afterSet[pid] = true
	}
	return members, inventory, complete && maps.Equal(pidSet, afterSet), inspectionErr
}

// arg=1 asks Darwin's BSD-info flavor to include zombies. They can remain
// in the UID census while no longer having a live task or coalition query.
func processBSDInfoIncludingZombies(pid int) ([]byte, error) {
	buffer := make([]byte, procBSDInfoSize)
	n, _, errno := syscall.Syscall6(syscall.SYS_PROC_INFO, procInfoCallPIDInfo, uintptr(pid), procPIDTBSDInfo, 1, uintptr(unsafe.Pointer(&buffer[0])), uintptr(len(buffer)))
	if errno != 0 {
		return nil, errno
	}
	if int(n) != procBSDInfoSize || int(binary.LittleEndian.Uint32(buffer[procBSDPIDOffset:])) != pid {
		return nil, errors.New("invalid kernel process identity")
	}
	return buffer, nil
}

// A standalone Python command has no supervisor registry. Its private launchd
// helper is only a transport; give the actual command root first chance to
// drain SDK children, just as a native supervisor does for API and worker.
func drainScopedCommandRoots(ctx launchContext, state instanceState, witnesses executionWitnesses) error {
	scopes, err := readOwnedExecutionScopes(ctx)
	if err != nil {
		return err
	}
	if len(scopes) == 0 {
		return nil
	}
	boot, err := executionBootSession()
	if err != nil {
		return err
	}
	members, err := inspectOwnedProcesses(ctx, state, witnesses)
	if err != nil {
		return err
	}
	current, err := currentExecutionScope(ctx, scopes, boot)
	if err != nil {
		return err
	}
	for _, scope := range scopes {
		if scope.BootSession != boot || scope.ID == current {
			continue
		}
		helper, err := processStartIdentity(scope.RootPID)
		if errors.Is(err, syscall.ESRCH) {
			continue
		}
		if err != nil {
			return err
		}
		if helper != scope.RootIdentity {
			continue
		}
		ids, err := processCoalitionIDs(scope.RootPID)
		if err != nil {
			return err
		}
		if ids != scope.CoalitionIDs {
			return errors.New("execution helper ownership changed")
		}
		for _, member := range members {
			if member.ParentPID != scope.RootPID || member.CoalitionIDs != scope.CoalitionIDs {
				continue
			}
			if err := signalDiscoveredProcess(member, syscall.SIGTERM); err != nil {
				return err
			}
			deadline := time.Now().Add(cooperativeShutdownTimeout)
			for time.Now().Before(deadline) {
				identity, err := processStartIdentity(member.PID)
				if errors.Is(err, syscall.ESRCH) || (err == nil && identity != member.Identity) {
					break
				}
				if err != nil {
					return err
				}
				info, err := processBSDInfoIncludingZombies(member.PID)
				if errors.Is(err, syscall.ESRCH) || (err == nil && binary.LittleEndian.Uint32(info[4:]) == 5) {
					break
				}
				if err != nil {
					return err
				}
				time.Sleep(50 * time.Millisecond)
			}
		}
		// A completed command's helper needs only to relay its exit status.
		// Let that short-lived transport finish before signaling leftovers.
		_ = waitForPIDExit(scope.RootPID, shutdownTimeout)
	}
	return nil
}

// The environment only names a receipt; current kernel membership supplies
// authority to exclude the caller's own transport from a cleanup census.
func currentExecutionScope(ctx launchContext, scopes []executionScope, boot string) (string, error) {
	requested := environmentMap(ctx.Environment)[executionScopeVariable]
	if requested == "" {
		return "", nil
	}
	ids, err := processCoalitionIDs(os.Getpid())
	if err != nil {
		return "", err
	}
	for _, scope := range scopes {
		if scope.ID == requested && scope.BootSession == boot && scope.CoalitionIDs == ids {
			return requested, nil
		}
	}
	return "", nil
}
