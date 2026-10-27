//go:build darwin

package launcher

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"
	"unsafe"
)

const executionScopeVariable = "JOBCTRL_EXECUTION_SCOPE"
const executionHelperArgument = "__scope-executor"

type executionScope struct {
	SchemaVersion int       `json:"schemaVersion"`
	ID            string    `json:"id"`
	InstanceID    string    `json:"instanceId"`
	StateDir      string    `json:"stateDir"`
	RuntimeHome   string    `json:"runtimeHome"`
	BootSession   string    `json:"bootSession"`
	JobLabel      string    `json:"jobLabel"`
	Domain        string    `json:"domain"`
	RootPID       int       `json:"rootPid"`
	RootIdentity  string    `json:"rootIdentity"`
	CoalitionIDs  [2]uint64 `json:"coalitionIds"`
}

type executionHello struct {
	PID       int    `json:"pid"`
	Challenge string `json:"challenge"`
}
type executionCommand struct {
	Executable             string
	Arguments, Environment []string
	Directory              string
}
type executionControl struct {
	Signal int `json:"signal"`
}

type executionResult struct {
	Code   int  `json:"code"`
	Failed bool `json:"failed"`
}
type ownedExecutionExitError struct{ code int }

func (e ownedExecutionExitError) Error() string {
	return fmt.Sprintf("owned execution exited with status %d", e.code)
}
func (e ownedExecutionExitError) ExitCode() int { return e.code }

// PROC_PIDCOALITIONINFO (Darwin sys/proc_info.h) is five uint64 slots;
// resource and jetsam are the first two. IDs survive reparenting and setsid.
func processCoalitionIDs(pid int) ([2]uint64, error) {
	var ids [2]uint64
	var raw [40]byte
	n, _, errno := syscall.Syscall6(syscall.SYS_PROC_INFO, 2, uintptr(pid), 20, 0, uintptr(unsafe.Pointer(&raw[0])), uintptr(len(raw)))
	if errno != 0 {
		return ids, errno
	}
	if n != uintptr(len(raw)) {
		return ids, errors.New("incomplete kernel coalition identity")
	}
	ids = [2]uint64{binary.LittleEndian.Uint64(raw[:8]), binary.LittleEndian.Uint64(raw[8:16])}
	if ids[0] == 0 || ids[1] == 0 {
		return ids, errors.New("missing kernel coalition identity")
	}
	return ids, nil
}
func executionBootSession() (string, error) {
	value, err := syscall.Sysctl("kern.bootsessionuuid")
	if err != nil {
		return "", err
	}
	value = strings.ToLower(strings.TrimSpace(value))
	if !validExecutionBootSession(value) {
		return "", errors.New("invalid boot session identity")
	}
	return value, nil
}

func validExecutionBootSession(value string) bool {
	if len(value) != 36 {
		return false
	}
	for i, c := range value {
		if i == 8 || i == 13 || i == 18 || i == 23 {
			if c != '-' {
				return false
			}
		} else if !strings.ContainsRune("0123456789abcdef", c) {
			return false
		}
	}
	return true
}
func executionIDValid(id string) bool {
	if len(id) != 32 {
		return false
	}
	for _, c := range id {
		if !strings.ContainsRune("0123456789abcdef", c) {
			return false
		}
	}
	return true
}
func executionScopeDirectory(ctx launchContext, create bool) (string, error) {
	dir := filepath.Join(filepath.Dir(ctx.Instance.StatePath), "executions")
	if create {
		if err := os.Mkdir(dir, 0700); err != nil && !errors.Is(err, os.ErrExist) {
			return "", err
		}
	}
	info, err := os.Lstat(dir)
	if err != nil {
		return "", err
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 || info.Mode().Perm() != 0700 || !ok || int(stat.Uid) != os.Getuid() {
		return "", errors.New("unsafe execution receipt directory")
	}
	return dir, nil
}
func validateExecutionScope(ctx launchContext, s executionScope) error {
	if s.SchemaVersion != 1 || !executionIDValid(s.ID) || s.InstanceID != ctx.Instance.ID || s.StateDir != ctx.Instance.StateDir || s.RuntimeHome != ctx.Instance.RuntimeHome || s.RootPID <= 0 || s.RootIdentity == "" || len(s.RootIdentity) > 128 || s.CoalitionIDs[0] == 0 || s.CoalitionIDs[1] == 0 || s.JobLabel != "dev.jobctrl.exec."+ctx.Instance.ID+"."+s.ID {
		return errors.New("invalid execution scope receipt")
	}
	if s.Domain != "gui/"+strconv.Itoa(os.Getuid()) && s.Domain != "user/"+strconv.Itoa(os.Getuid()) {
		return errors.New("foreign execution domain")
	}
	parts := strings.Split(s.RootIdentity, ":")
	if len(parts) != 3 || parts[0] != strconv.Itoa(s.RootPID) {
		return errors.New("invalid execution root identity")
	}
	seconds, secErr := strconv.ParseUint(parts[1], 10, 64)
	micros, microErr := strconv.ParseUint(parts[2], 10, 64)
	if secErr != nil || microErr != nil || seconds == 0 || micros >= 1000000 {
		return errors.New("invalid execution root identity")
	}
	if !validExecutionBootSession(s.BootSession) {
		return errors.New("invalid execution boot receipt")
	}
	return nil
}
func executionReceiptTemporaryName(name string) bool {
	// writeJSONAtomic uses .<final basename>.<random 32hex nonce>.
	return len(name) == 71 && name[0] == '.' && name[33:39] == ".json." && executionIDValid(name[1:33]) && executionIDValid(name[39:])
}

func readOwnedExecutionScopes(ctx launchContext) ([]executionScope, error) {
	dir, err := executionScopeDirectory(ctx, false)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}
	if len(entries) > 10000 {
		return nil, errors.New("execution receipt bound exceeded")
	}
	scopes := make([]executionScope, 0, len(entries))
	for _, entry := range entries {
		if executionReceiptTemporaryName(entry.Name()) {
			// A producer can crash before atomic publication. These private
			// files never authorize work and are preserved for investigation.
			file, err := os.OpenFile(filepath.Join(dir, entry.Name()), os.O_RDONLY|syscall.O_NOFOLLOW, 0)
			if err != nil {
				return nil, err
			}
			info, err := file.Stat()
			file.Close()
			if err != nil {
				return nil, err
			}
			stat, ok := info.Sys().(*syscall.Stat_t)
			if !info.Mode().IsRegular() || info.Mode().Perm() != 0600 || info.Size() > 16384 || !ok || int(stat.Uid) != os.Getuid() {
				return nil, errors.New("unsafe temporary execution receipt")
			}
			continue
		}
		id := strings.TrimSuffix(entry.Name(), ".json")
		if entry.Name() != id+".json" || !executionIDValid(id) {
			return nil, errors.New("unfamiliar execution receipt")
		}
		file, err := os.OpenFile(filepath.Join(dir, entry.Name()), os.O_RDONLY|syscall.O_NOFOLLOW, 0)
		if err != nil {
			return nil, err
		}
		info, statErr := file.Stat()
		if statErr != nil {
			file.Close()
			return nil, statErr
		}
		stat, ok := info.Sys().(*syscall.Stat_t)
		if !info.Mode().IsRegular() || info.Mode().Perm() != 0600 || info.Size() > 16384 || !ok || int(stat.Uid) != os.Getuid() {
			file.Close()
			return nil, errors.New("unsafe execution receipt")
		}
		raw, readErr := io.ReadAll(io.LimitReader(file, 16385))
		file.Close()
		var scope executionScope
		err = readErr
		if err == nil {
			err = decodeExecutionReceipt(raw, &scope)
		}
		if err != nil {
			return nil, errors.New("malformed execution receipt")
		}
		if scope.ID != id {
			return nil, errors.New("execution receipt filename mismatch")
		}
		if err = validateExecutionScope(ctx, scope); err != nil {
			return nil, err
		}
		scopes = append(scopes, scope)
	}
	return scopes, nil
}

// Receipt keys have one exact spelling. encoding/json alone accepts duplicate
// fields and case-insensitive aliases, so check the object before struct decode.
func decodeExecutionReceipt(raw []byte, scope *executionScope) error {
	allowed := map[string]bool{"schemaVersion": true, "id": true, "instanceId": true, "stateDir": true, "runtimeHome": true, "bootSession": true, "jobLabel": true, "domain": true, "rootPid": true, "rootIdentity": true, "coalitionIds": true}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	token, err := decoder.Token()
	if err != nil || token != json.Delim('{') {
		return errors.New("invalid execution receipt object")
	}
	seen := map[string]bool{}
	for decoder.More() {
		token, err = decoder.Token()
		key, ok := token.(string)
		if err != nil || !ok || !allowed[key] || seen[key] {
			return errors.New("unfamiliar or repeated execution receipt key")
		}
		seen[key] = true
		var value json.RawMessage
		if err := decoder.Decode(&value); err != nil {
			return err
		}
	}
	if token, err = decoder.Token(); err != nil || token != json.Delim('}') {
		return errors.New("invalid execution receipt end")
	}
	if len(seen) != len(allowed) {
		return errors.New("incomplete execution receipt")
	}
	var extra any
	if decoder.Decode(&extra) != io.EOF {
		return errors.New("trailing execution receipt")
	}
	return json.Unmarshal(raw, scope)
}

func executionMembers(ids [2]uint64) ([]ownedProcess, error) {
	pids, err := userProcessIDs()
	if err != nil {
		return nil, err
	}
	var members []ownedProcess
	for _, pid := range pids {
		if pid == os.Getpid() {
			continue
		}
		info, err := procInfo(pid, procPIDTBSDInfo, procBSDInfoSize)
		if errors.Is(err, syscall.ESRCH) {
			continue
		}
		if err != nil {
			return nil, err
		}
		if binary.LittleEndian.Uint32(info[4:]) == 5 {
			continue
		}
		before, err := processStartIdentity(pid)
		if errors.Is(err, syscall.ESRCH) {
			continue
		}
		if err != nil {
			return nil, err
		}
		memberIDs, err := processCoalitionIDs(pid)
		if errors.Is(err, syscall.ESRCH) {
			continue
		}
		if err != nil {
			return nil, err
		}
		if memberIDs != ids {
			continue
		}
		after, err := processStartIdentity(pid)
		if errors.Is(err, syscall.ESRCH) {
			continue
		}
		if err != nil {
			return nil, err
		}
		if before == after {
			members = append(members, ownedProcess{PID: pid, Identity: after})
		}
	}
	return members, nil
}

func signalExecutionRoot(ids [2]uint64, pid int, identity string, requested syscall.Signal) error {
	info, err := procInfo(pid, procPIDTBSDInfo, procBSDInfoSize)
	if errors.Is(err, syscall.ESRCH) {
		return nil
	}
	if err != nil {
		return err
	}
	if binary.LittleEndian.Uint32(info[4:]) == 5 {
		return nil
	}
	if int(binary.LittleEndian.Uint32(info[20:])) != os.Getuid() {
		return errors.New("execution root uid changed")
	}
	before := processIdentityFromBSD(info)
	if identity == "" {
		return errors.New("execution root identity unavailable")
	}
	if before != identity {
		return nil
	} // The recorded root exited; never signal a reused PID.
	currentIDs, err := processCoalitionIDs(pid)
	if errors.Is(err, syscall.ESRCH) {
		return nil
	}
	if err != nil {
		return err
	}
	if currentIDs != ids {
		return errors.New("execution root coalition changed")
	}
	after, err := processStartIdentity(pid)
	if errors.Is(err, syscall.ESRCH) {
		return nil
	}
	if err != nil {
		return err
	}
	if after != identity {
		return nil
	}
	err = syscall.Kill(pid, requested)
	if errors.Is(err, syscall.ESRCH) {
		return nil
	}
	return err
}

func signalExecutionMembers(ids [2]uint64, requested syscall.Signal) error {
	members, err := executionMembers(ids)
	if err != nil {
		return err
	}
	for _, member := range members {
		if err := signalExecutionRoot(ids, member.PID, member.Identity, requested); err != nil {
			return err
		}
	}
	return nil
}

func waitExecutionRoot(pid int, identity string, timeout time.Duration) (bool, error) {
	deadline := time.Now().Add(timeout)
	for {
		info, err := procInfo(pid, procPIDTBSDInfo, procBSDInfoSize)
		if errors.Is(err, syscall.ESRCH) {
			return true, nil
		}
		if err != nil {
			return false, err
		}
		if binary.LittleEndian.Uint32(info[4:]) == 5 || processIdentityFromBSD(info) != identity {
			return true, nil
		}
		if time.Now().After(deadline) {
			return false, nil
		}
		time.Sleep(25 * time.Millisecond)
	}
}

func waitExecutionMembers(ids [2]uint64, timeout time.Duration) (bool, error) {
	deadline := time.Now().Add(timeout)
	for {
		members, err := executionMembers(ids)
		if err != nil {
			return false, err
		}
		if len(members) == 0 {
			return true, nil
		}
		if time.Now().After(deadline) {
			return false, nil
		}
		time.Sleep(100 * time.Millisecond)
	}
}

func executionShutdownGrace(args []string) time.Duration {
	if len(args) > 0 && (args[0] == "start" || args[0] == "dev" || args[0] == "__supervise") {
		return supervisorShutdownTimeout
	}
	return cooperativeShutdownTimeout
}

func cleanupExecutionMembers(ids [2]uint64, rootPID int, rootIdentity string, args []string) error {
	// The command root owns ordered shutdown. Its descendants receive no
	// external signal until that owner exits or its existing grace expires.
	if err := signalExecutionRoot(ids, rootPID, rootIdentity, syscall.SIGTERM); err != nil {
		return err
	}
	if _, err := waitExecutionRoot(rootPID, rootIdentity, executionShutdownGrace(args)); err != nil {
		return err
	}
	if err := signalExecutionMembers(ids, syscall.SIGTERM); err != nil {
		return err
	}
	if zero, err := waitExecutionMembers(ids, shutdownTimeout); err != nil {
		return err
	} else if zero {
		return nil
	}
	if err := signalExecutionMembers(ids, syscall.SIGKILL); err != nil {
		return err
	}
	if zero, err := waitExecutionMembers(ids, shutdownTimeout); err != nil {
		return err
	} else if !zero {
		return errors.New("owned execution members survived cleanup")
	}
	return nil
}

func authenticatedOwnedExecution(ctx launchContext) (bool, error) {
	id := environmentMap(ctx.Environment)[executionScopeVariable]
	if id == "" {
		return false, nil
	}
	if !executionIDValid(id) {
		return false, errors.New("invalid execution scope authorization")
	}
	scopes, err := readOwnedExecutionScopes(ctx)
	if err != nil {
		return false, err
	}
	boot, err := executionBootSession()
	if err != nil {
		return false, err
	}
	ids, err := processCoalitionIDs(os.Getpid())
	if err != nil {
		return false, err
	}
	for _, scope := range scopes {
		if scope.ID == id && scope.BootSession == boot && scope.CoalitionIDs == ids {
			return true, nil
		}
	}
	return false, errors.New("execution scope authorization does not match this process")
}

// The helper admits no work until it receives both stdio and the authorized
// command over its parent's private socket. EOF before that point is inert.
func ownedExecutionHelper(args []string) (bool, error) {
	if len(args) == 0 || args[0] != executionHelperArgument {
		return false, nil
	}
	if len(args) != 3 || !executionIDValid(args[2]) || !filepath.IsAbs(args[1]) {
		return true, errors.New("invalid private execution helper arguments")
	}
	connection, err := net.DialUnix("unix", nil, &net.UnixAddr{Name: args[1], Net: "unix"})
	if err != nil {
		return true, errors.New("connect execution authorization")
	}
	defer connection.Close()
	_ = connection.SetDeadline(time.Now().Add(20 * time.Second))
	if err = json.NewEncoder(connection).Encode(executionHello{os.Getpid(), args[2]}); err != nil {
		return true, err
	}
	var data [1]byte
	rights := make([]byte, syscall.CmsgSpace(3*4))
	n, oobn, _, _, err := connection.ReadMsgUnix(data[:], rights)
	if err != nil {
		return true, errors.New("execution authorization was not received")
	}
	messages, err := syscall.ParseSocketControlMessage(rights[:oobn])
	if err != nil || n != 1 || data[0] != 1 || len(messages) != 1 {
		return true, errors.New("invalid execution descriptors")
	}
	fds, err := syscall.ParseUnixRights(&messages[0])
	if err != nil {
		return true, err
	}
	defer func() {
		for _, fd := range fds {
			syscall.Close(fd)
		}
	}()
	if len(fds) != 3 {
		return true, errors.New("invalid execution descriptor count")
	}
	decoder := json.NewDecoder(io.LimitReader(connection, 8<<20))
	decoder.DisallowUnknownFields()
	var command executionCommand
	if err = decoder.Decode(&command); err != nil {
		return true, errors.New("execution authorization was interrupted")
	}
	if !filepath.IsAbs(command.Executable) || !filepath.IsAbs(command.Directory) {
		return true, errors.New("invalid authorized command")
	}
	_ = connection.SetDeadline(time.Time{})
	child := exec.Command(command.Executable, command.Arguments...)
	child.Env = command.Environment
	child.Dir = command.Directory
	// os.File owns each descriptor from this point.
	files := []*os.File{os.NewFile(uintptr(fds[0]), "stdin"), os.NewFile(uintptr(fds[1]), "stdout"), os.NewFile(uintptr(fds[2]), "stderr")}
	fds = nil
	defer func() {
		for _, f := range files {
			f.Close()
		}
	}()
	child.Stdin = files[0]
	child.Stdout = files[1]
	child.Stderr = files[2]
	ids, err := processCoalitionIDs(os.Getpid())
	if err != nil {
		return true, err
	}
	if err = child.Start(); err != nil {
		_ = json.NewEncoder(connection).Encode(executionResult{Code: 1, Failed: true})
		return true, errors.New("authorized command could not start")
	}
	rootIdentity, identityErr := processStartIdentity(child.Process.Pid)
	if identityErr != nil && !errors.Is(identityErr, syscall.ESRCH) {
		go child.Wait()
		return true, errors.New("could not inspect authorized command identity")
	}
	waited := make(chan error, 1)
	go func() { waited <- child.Wait() }()
	controls := make(chan executionControl)
	controlErrors := make(chan error, 1)
	finished := make(chan struct{})
	defer close(finished)
	go func() {
		for {
			var control executionControl
			if err := decoder.Decode(&control); err != nil {
				controlErrors <- err
				return
			}
			select {
			case controls <- control:
			case <-finished:
				return
			}
		}
	}()
	var waitErr error
waiting:
	for {
		select {
		case waitErr = <-waited:
			break waiting
		case control := <-controls:
			if control.Signal != int(syscall.SIGINT) && control.Signal != int(syscall.SIGTERM) {
				cleanupErr := cleanupExecutionMembers(ids, child.Process.Pid, rootIdentity, command.Arguments)
				return true, errors.Join(errors.New("invalid execution control"), cleanupErr)
			}
			// Only the verified command root receives interactive cancellation.
			// A native supervisor retains ownership of its ordered child drain.
			if err := signalExecutionRoot(ids, child.Process.Pid, rootIdentity, syscall.Signal(control.Signal)); err != nil {
				cleanupErr := cleanupExecutionMembers(ids, child.Process.Pid, rootIdentity, command.Arguments)
				return true, errors.Join(errors.New("could not forward execution signal"), err, cleanupErr)
			}
		case <-controlErrors:
			// Losing the authenticated controller is never success. Receipts
			// remain durable even if inspection or bounded cleanup fails.
			cleanupErr := cleanupExecutionMembers(ids, child.Process.Pid, rootIdentity, command.Arguments)
			return true, errors.Join(errors.New("execution controller disconnected"), cleanupErr)
		}
	}
	result := executionResult{}
	if waitErr != nil {
		var exited *exec.ExitError
		if errors.As(waitErr, &exited) {
			result.Code = exited.ExitCode()
			if result.Code < 0 {
				result.Code = 128 + int(exited.Sys().(syscall.WaitStatus).Signal())
			}
		} else {
			result.Code = 1
			result.Failed = true
		}
	}
	if err = json.NewEncoder(connection).Encode(result); err != nil {
		cleanupErr := cleanupExecutionMembers(ids, child.Process.Pid, rootIdentity, command.Arguments)
		return true, errors.Join(err, cleanupErr)
	}
	if result.Code != 0 {
		return true, ownedExecutionExitError{result.Code}
	}
	return true, nil
}

func executionPlist(label, executable, socket, challenge string) []byte {
	escape := func(s string) string { var b bytes.Buffer; _ = xml.EscapeText(&b, []byte(s)); return b.String() }
	return []byte(`<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key><string>` + escape(label) + `</string><key>ProgramArguments</key><array><string>` + escape(executable) + `</string><string>` + executionHelperArgument + `</string><string>` + escape(socket) + `</string><string>` + escape(challenge) + `</string></array><key>RunAtLoad</key><true/><key>KeepAlive</key><false/></dict></plist>`)
}

func executionOutput(writer io.Writer) (*os.File, func(), error) {
	if file, ok := writer.(*os.File); ok {
		return file, func() {}, nil
	}
	read, write, err := os.Pipe()
	if err != nil {
		return nil, nil, err
	}
	done := make(chan struct{})
	go func() { _, _ = io.Copy(writer, read); close(done) }()
	return write, func() {
		write.Close()
		select {
		case <-done:
		case <-time.After(time.Second):
			read.Close()
			<-done
		}
		read.Close()
	}, nil
}

func runInOwnedExecution(ctx launchContext, args []string, stdout, stderr io.Writer) error {
	controlPath := ctx.Instance.ControlPath
	if controlPath == "" {
		controlPath = filepath.Join(filepath.Dir(ctx.Instance.StatePath), "control.lock")
	}
	admission, err := acquireLock(controlPath, false)
	if err != nil {
		return fmt.Errorf("acquire execution admission lock: %w", err)
	}
	defer func() { releaseLock(admission) }()
	executable, err := CurrentProcessExecutable()
	if err != nil {
		return err
	}
	if !sameExecutable(executable, ctx.Executable) {
		return errors.New("execution launcher does not match authenticated executable")
	}
	id, err := releaseRandomID()
	if err != nil {
		return err
	}
	challenge, err := releaseRandomID()
	if err != nil {
		return err
	}
	dir, err := executionScopeDirectory(ctx, true)
	if err != nil {
		return err
	}
	boot, err := executionBootSession()
	if err != nil {
		return err
	}
	temporary, err := os.MkdirTemp("/tmp", "jc-exec-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(temporary)
	socket := filepath.Join(temporary, "control")
	listener, err := net.ListenUnix("unix", &net.UnixAddr{Name: socket, Net: "unix"})
	if err != nil {
		return err
	}
	defer listener.Close()
	_ = listener.SetDeadline(time.Now().Add(20 * time.Second))
	label := "dev.jobctrl.exec." + ctx.Instance.ID + "." + id
	plist := filepath.Join(temporary, "job.plist")
	if err = os.WriteFile(plist, executionPlist(label, executable, socket, challenge), 0600); err != nil {
		return err
	}
	domain := ""
	for _, candidate := range []string{"gui/" + strconv.Itoa(os.Getuid()), "user/" + strconv.Itoa(os.Getuid())} {
		if exec.Command("/bin/launchctl", "bootstrap", candidate, plist).Run() == nil {
			domain = candidate
			break
		}
	}
	if domain == "" {
		return errors.New("could not establish a private per-user execution scope")
	}
	defer exec.Command("/bin/launchctl", "bootout", domain+"/"+label).Run()
	connection, err := listener.AcceptUnix()
	if err != nil {
		return errors.New("execution helper did not connect")
	}
	defer connection.Close()
	_ = connection.SetDeadline(time.Now().Add(20 * time.Second))
	decoder := json.NewDecoder(connection)
	var hello executionHello
	if err = decoder.Decode(&hello); err != nil || hello.Challenge != challenge || hello.PID <= 0 {
		return errors.New("invalid execution helper identity")
	}
	identity, err := processStartIdentity(hello.PID)
	if err != nil {
		return err
	}
	path, err := processExecutable(hello.PID)
	if err != nil || !sameExecutable(path, executable) {
		return errors.New("execution helper executable mismatch")
	}
	ids, err := processCoalitionIDs(hello.PID)
	if err != nil {
		return err
	}
	callerIDs, err := processCoalitionIDs(os.Getpid())
	if err != nil {
		return err
	}
	if ids[0] == callerIDs[0] || ids[1] == callerIDs[1] {
		return errors.New("execution helper did not receive an isolated coalition")
	}
	after, err := processStartIdentity(hello.PID)
	if err != nil || after != identity {
		return errors.New("execution helper identity changed")
	}
	scope := executionScope{1, id, ctx.Instance.ID, ctx.Instance.StateDir, ctx.Instance.RuntimeHome, boot, label, domain, hello.PID, identity, ids}
	if err = validateExecutionScope(ctx, scope); err != nil {
		return err
	}
	if err = writeJSONAtomic(filepath.Join(dir, id+".json"), scope); err != nil {
		return err
	}
	if err = syncDirectory(dir); err != nil {
		return err
	}
	out, closeOut, err := executionOutput(stdout)
	if err != nil {
		return err
	}
	defer closeOut()
	errout, closeErr, err := executionOutput(stderr)
	if err != nil {
		return err
	}
	defer closeErr()
	environment := make([]string, 0, len(ctx.Environment)+1)
	for _, value := range ctx.Environment {
		if !strings.HasPrefix(value, executionScopeVariable+"=") {
			environment = append(environment, value)
		}
	}
	environment = append(environment, executionScopeVariable+"="+id)
	cwd, err := os.Getwd()
	if err != nil {
		return err
	}
	signals := make(chan os.Signal, 8)
	signal.Notify(signals, os.Interrupt, syscall.SIGTERM)
	defer signal.Stop(signals)
	forwardingDone := make(chan struct{})
	defer close(forwardingDone)
	if _, _, err = connection.WriteMsgUnix([]byte{1}, syscall.UnixRights(int(os.Stdin.Fd()), int(out.Fd()), int(errout.Fd())), nil); err != nil {
		return err
	}
	if err = json.NewEncoder(connection).Encode(executionCommand{executable, args, environment, cwd}); err != nil {
		return errors.New("could not authorize execution")
	}
	// Stop can now see the durable receipt before it obtains its exclusive
	// control lock. Waiting for the command result must never hold admission.
	releaseLock(admission)
	admission = nil
	_ = connection.SetDeadline(time.Time{})
	go func() {
		encoder := json.NewEncoder(connection)
		for {
			select {
			case received := <-signals:
				if err := encoder.Encode(executionControl{Signal: int(received.(syscall.Signal))}); err != nil {
					connection.Close()
					return
				}
			case <-forwardingDone:
				return
			}
		}
	}()
	var result executionResult
	if err = decoder.Decode(&result); err != nil {
		return errors.New("execution helper exited without a command result")
	}
	if result.Failed {
		return errors.New("authorized command could not start")
	}
	if result.Code < 0 || result.Code > 255 {
		return errors.New("invalid execution result")
	}
	if result.Code != 0 {
		return ownedExecutionExitError{result.Code}
	}
	return nil
}

// Called only after an all-instance zero census, with the stop control lock
// held. A receipt is retained on a genuine bootout failure; no names outside
// the strict ledger are submitted to launchctl or removed from disk.
func retireOwnedExecutionScopes(ctx launchContext) error {
	scopes, err := readOwnedExecutionScopes(ctx)
	if err != nil || len(scopes) == 0 {
		return err
	}
	dir, err := executionScopeDirectory(ctx, false)
	if err != nil {
		return err
	}
	type snapshot struct {
		scope executionScope
		raw   []byte
		info  os.FileInfo
	}
	snapshots := make([]snapshot, 0, len(scopes))
	for _, scope := range scopes {
		path := filepath.Join(dir, scope.ID+".json")
		file, err := os.OpenFile(path, os.O_RDONLY|syscall.O_NOFOLLOW, 0)
		if err != nil {
			return err
		}
		info, err := file.Stat()
		if err != nil {
			file.Close()
			return err
		}
		raw, err := io.ReadAll(io.LimitReader(file, 16385))
		file.Close()
		if err != nil {
			return err
		}
		var current executionScope
		if decodeExecutionReceipt(raw, &current) != nil || current != scope {
			return errors.New("execution receipt changed before retirement")
		}
		snapshots = append(snapshots, snapshot{scope, raw, info})
	}
	// Complete every fallible launchd operation before deleting any receipt.
	for _, snapshot := range snapshots {
		if err := bootoutOwnedExecution(snapshot.scope.Domain, snapshot.scope.JobLabel); err != nil {
			return errors.New("could not retire owned execution job; receipts preserved")
		}
	}
	current, err := readOwnedExecutionScopes(ctx)
	if err != nil {
		return err
	}
	if len(current) != len(snapshots) {
		return errors.New("execution receipt set changed during retirement")
	}
	for _, snapshot := range snapshots {
		file, err := os.OpenFile(filepath.Join(dir, snapshot.scope.ID+".json"), os.O_RDONLY|syscall.O_NOFOLLOW, 0)
		if err != nil {
			return err
		}
		info, err := file.Stat()
		if err != nil {
			file.Close()
			return err
		}
		raw, err := io.ReadAll(io.LimitReader(file, 16385))
		file.Close()
		if err != nil {
			return err
		}
		if !os.SameFile(info, snapshot.info) || !bytes.Equal(raw, snapshot.raw) {
			return errors.New("execution receipt changed during retirement")
		}
	}
	// If a filesystem failure interrupts the removal set, restore only
	// absent paths with their original private bytes. Never overwrite a file
	// that appeared or changed while retirement was in progress.
	restore := func() error {
		var failures []error
		for _, snapshot := range snapshots {
			path := filepath.Join(dir, snapshot.scope.ID+".json")
			file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL|syscall.O_NOFOLLOW, 0600)
			if errors.Is(err, os.ErrExist) {
				continue
			}
			if err != nil {
				failures = append(failures, err)
				continue
			}
			_, writeErr := file.Write(snapshot.raw)
			syncErr := file.Sync()
			closeErr := file.Close()
			failures = append(failures, writeErr, syncErr, closeErr)
		}
		failures = append(failures, syncDirectory(dir))
		return errors.Join(failures...)
	}
	for _, snapshot := range snapshots {
		if err := os.Remove(filepath.Join(dir, snapshot.scope.ID+".json")); err != nil {
			return errors.Join(err, restore())
		}
	}
	if err := syncDirectory(dir); err != nil {
		return errors.Join(err, restore())
	}
	return nil
}

var bootoutOwnedExecution = func(domain, label string) error {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	err := exec.CommandContext(ctx, "/bin/launchctl", "bootout", domain+"/"+label).Run()
	var exited *exec.ExitError
	if errors.As(err, &exited) && (exited.ExitCode() == int(syscall.ENOENT) || exited.ExitCode() == int(syscall.ESRCH)) {
		return nil
	}
	return err
}
