// Package release owns the durable, user-owned release selection state.  It is
// deliberately independent from acquisition and process supervision so the
// launcher and installer can share one transaction boundary without an import
// cycle.
package release

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"syscall"
	"time"
)

var digestPattern = regexp.MustCompile(`^[a-f0-9]{64}$`)

const (
	ActiveFile  = "active.json"
	JournalFile = "transition.json"
)

// Receipt is immutable release evidence. Acquisition is intentionally not a
// receipt property: the same immutable artifact may be acquired first through
// curl and later through Homebrew (or the reverse) without changing its
// identity. Acquisition ownership belongs to Active instead.
type Receipt struct {
	SchemaVersion    int    `json:"schemaVersion"`
	BuildID          string `json:"buildId"`
	Channel          string `json:"channel"`
	Sequence         uint64 `json:"sequence"`
	ArtifactSHA256   string `json:"artifactSha256"`
	ManifestSHA256   string `json:"manifestSha256"`
	DescriptorSHA256 string `json:"descriptorSha256"`
	PolicySHA256     string `json:"policySha256,omitempty"`
	DescriptorURL    string `json:"descriptorUrl"`
	InstalledAt      string `json:"installedAt"`
}

func (r Receipt) Valid() bool {
	versionValid := (r.SchemaVersion == 1 && r.PolicySHA256 == "") || (r.SchemaVersion == 2 && digestPattern.MatchString(r.PolicySHA256))
	return versionValid && r.BuildID != "" && r.Sequence > 0 &&
		(r.Channel == "local" || r.Channel == "stable" || r.Channel == "prerelease") &&
		digestPattern.MatchString(r.ArtifactSHA256) && digestPattern.MatchString(r.ManifestSHA256) &&
		digestPattern.MatchString(r.DescriptorSHA256) && r.InstalledAt != ""
}

type Active struct {
	SchemaVersion   int     `json:"schemaVersion"`
	Generation      uint64  `json:"generation"`
	Receipt         Receipt `json:"receipt"`
	SelectorBuildID string  `json:"selectorBuildId"`
	Acquisition     string  `json:"acquisition,omitempty"`
}

// ChannelState is signed-channel safety evidence accumulated monotonically.
// Its union semantics mean a later descriptor can never quietly un-revoke a
// build, lower a safety floor, or reuse a sequence for another identity.
type ChannelState struct {
	SchemaVersion       int               `json:"schemaVersion"`
	Channel             string            `json:"channel"`
	MaxSequence         uint64            `json:"maxSequence"`
	MinimumSafeSequence uint64            `json:"minimumSafeSequence"`
	RevokedBuildIDs     map[string]bool   `json:"revokedBuildIds"`
	SequenceBuildIDs    map[string]string `json:"sequenceBuildIds"`
	SequenceDescriptors map[string]string `json:"sequenceDescriptors"`
}

// ChannelMetadata is authenticated but not yet durable policy state. The
// installer validates it before committing a candidate and the lifecycle
// finalizes it only after the candidate and old database pair are durable.
// This prevents a crash from revoking the active release while the replacement
// exists only in staging.
type ChannelMetadata struct {
	Channel          string   `json:"channel"`
	Sequence         uint64   `json:"sequence"`
	Minimum          uint64   `json:"minimumSafeSequence"`
	BuildID          string   `json:"buildId"`
	DescriptorDigest string   `json:"descriptorSha256"`
	Revoked          []string `json:"revokedBuildIds"`
}

func (s *Store) ReadChannelState(channel string) (ChannelState, error) {
	var state ChannelState
	err := readStrictRegular(filepath.Join(s.Home, "channel-"+channel+".json"), &state)
	if errors.Is(err, os.ErrNotExist) {
		return ChannelState{SchemaVersion: 1, Channel: channel, RevokedBuildIDs: map[string]bool{}, SequenceBuildIDs: map[string]string{}, SequenceDescriptors: map[string]string{}}, nil
	}
	if err != nil {
		return state, err
	}
	if state.SchemaVersion != 1 || state.Channel != channel || state.RevokedBuildIDs == nil || state.SequenceBuildIDs == nil || state.SequenceDescriptors == nil {
		return state, errors.New("invalid channel safety record")
	}
	return state, nil
}

// ValidateMetadata rejects replay/downgrade/identity drift without changing
// durable policy. It is safe to call before candidate extraction/commit.
func (s *Store) ValidateMetadata(metadata ChannelMetadata) (ChannelState, error) {
	if metadata.Channel == "" || metadata.Sequence == 0 || metadata.BuildID == "" || !digestPattern.MatchString(metadata.DescriptorDigest) || metadata.Minimum > metadata.Sequence {
		return ChannelState{}, errors.New("invalid signed channel metadata")
	}
	state, err := s.ReadChannelState(metadata.Channel)
	if err != nil {
		return state, err
	}
	if metadata.Sequence < state.MaxSequence {
		return state, fmt.Errorf("release sequence %d is below recorded maximum %d", metadata.Sequence, state.MaxSequence)
	}
	if metadata.Sequence < state.MinimumSafeSequence || metadata.Minimum < state.MinimumSafeSequence {
		return state, fmt.Errorf("release sequence %d is below recorded minimum-safe sequence %d", metadata.Sequence, state.MinimumSafeSequence)
	}
	key := fmt.Sprintf("%d", metadata.Sequence)
	if prior := state.SequenceBuildIDs[key]; prior != "" && prior != metadata.BuildID {
		return state, fmt.Errorf("release sequence %d was already bound to build %q", metadata.Sequence, prior)
	}
	if prior := state.SequenceDescriptors[key]; prior != "" && prior != metadata.DescriptorDigest {
		return state, fmt.Errorf("release sequence %d descriptor identity drift", metadata.Sequence)
	}
	if state.RevokedBuildIDs[metadata.BuildID] {
		return state, fmt.Errorf("release build %q is revoked", metadata.BuildID)
	}
	for _, id := range metadata.Revoked {
		if id == "" {
			return state, errors.New("invalid revoked build identity")
		}
		state.RevokedBuildIDs[id] = true
	}
	if state.RevokedBuildIDs[metadata.BuildID] {
		return state, fmt.Errorf("release build %q is revoked", metadata.BuildID)
	}
	if metadata.Sequence > state.MaxSequence {
		state.MaxSequence = metadata.Sequence
	}
	if metadata.Minimum > state.MinimumSafeSequence {
		state.MinimumSafeSequence = metadata.Minimum
	}
	state.SequenceBuildIDs[key] = metadata.BuildID
	state.SequenceDescriptors[key] = metadata.DescriptorDigest
	return state, nil
}

// CommitMetadata persists a state already produced by ValidateMetadata. The
// caller journals PolicyPending before this directory-synced write.
func (s *Store) CommitMetadata(state ChannelState) error {
	if state.SchemaVersion != 1 || state.Channel == "" || state.RevokedBuildIDs == nil || state.SequenceBuildIDs == nil || state.SequenceDescriptors == nil {
		return errors.New("invalid channel safety record")
	}
	if err := writeAtomic(filepath.Join(s.Home, "channel-"+state.Channel+".json"), state); err != nil {
		return err
	}
	return nil
}

// RecordMetadata is retained for first-install callers and focused tests. A
// lifecycle promotion must instead validate, journal, and then commit.
func (s *Store) RecordMetadata(channel string, sequence, minimum uint64, buildID, descriptorDigest string, revoked []string) (ChannelState, error) {
	state, err := s.ValidateMetadata(ChannelMetadata{Channel: channel, Sequence: sequence, Minimum: minimum, BuildID: buildID, DescriptorDigest: descriptorDigest, Revoked: revoked})
	if err != nil {
		return state, err
	}
	return state, s.CommitMetadata(state)
}

func (s *Store) Permit(receipt Receipt) error {
	state, err := s.ReadChannelState(receipt.Channel)
	if err != nil {
		return err
	}
	if receipt.Sequence < state.MinimumSafeSequence {
		return fmt.Errorf("release sequence %d is below minimum-safe sequence %d", receipt.Sequence, state.MinimumSafeSequence)
	}
	if state.RevokedBuildIDs[receipt.BuildID] {
		return fmt.Errorf("release build %q is revoked", receipt.BuildID)
	}
	key := fmt.Sprintf("%d", receipt.Sequence)
	if prior := state.SequenceBuildIDs[key]; prior != "" && prior != receipt.BuildID {
		return fmt.Errorf("release sequence %d identity drift", receipt.Sequence)
	}
	if prior := state.SequenceDescriptors[key]; prior != "" && prior != receipt.DescriptorSHA256 {
		return fmt.Errorf("release sequence %d descriptor identity drift", receipt.Sequence)
	}
	return nil
}

// States are append-only audit milestones. A journal is deliberately kept
// after success; a following lifecycle operation begins a new journal ID.
type State string

const (
	Idle                   State = "idle"
	MetadataVerified       State = "metadata_verified"
	Staging                State = "staging"
	PayloadVerified        State = "payload_verified"
	ReleaseCommitted       State = "release_committed"
	SelectorHandoffPending State = "selector_handoff_pending"
	SelectorReplaced       State = "selector_replaced"
	Quiescing              State = "quiescing"
	PairBackedUp           State = "pair_backed_up"
	PolicyPending          State = "policy_pending"
	PolicyFinalized        State = "policy_finalized"
	CandidateStarting      State = "candidate_starting"
	CandidateHealthy       State = "candidate_healthy"
	Promoted               State = "promoted"
	RollbackRestoring      State = "rollback_restoring"
	RolledBack             State = "rolled_back"
	Failed                 State = "failed"
)

type Journal struct {
	SchemaVersion    int              `json:"schemaVersion"`
	ID               string           `json:"id"`
	Operation        string           `json:"operation"`
	State            State            `json:"state"`
	Old              *Receipt         `json:"old,omitempty"`
	Candidate        *Receipt         `json:"candidate,omitempty"`
	DescriptorSHA256 string           `json:"descriptorSha256,omitempty"`
	PendingPolicy    *ChannelMetadata `json:"pendingPolicy,omitempty"`
	BackupID         string           `json:"backupId,omitempty"`
	TargetBackupID   string           `json:"targetBackupId,omitempty"`
	Error            string           `json:"error,omitempty"`
	UpdatedAt        time.Time        `json:"updatedAt"`
}

func (j Journal) Resumable() bool {
	return j.State != Idle && j.State != Promoted && j.State != RolledBack && j.State != Failed
}

type Store struct{ Home string }

// Open refuses symlinked management roots and creates only owner-private
// paths. It never follows a user-controlled final component.
func Open(home string) (*Store, error) {
	abs, err := filepath.Abs(home)
	if err != nil {
		return nil, err
	}
	if err := ensureDirectory(abs); err != nil {
		return nil, err
	}
	for _, child := range []string{"releases", "staging", "backups", "bin"} {
		if err := ensureDirectory(filepath.Join(abs, child)); err != nil {
			return nil, err
		}
	}
	return &Store{Home: abs}, nil
}

func ensureDirectory(path string) error {
	if info, err := os.Lstat(path); err == nil {
		if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
			return fmt.Errorf("managed path %q is not a regular directory", path)
		}
		return os.Chmod(path, 0o700)
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	if err := os.Mkdir(path, 0o700); err != nil && !errors.Is(err, os.ErrExist) {
		return err
	}
	info, err := os.Lstat(path)
	if err != nil {
		return err
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return fmt.Errorf("managed path %q is not a regular directory", path)
	}
	return os.Chmod(path, 0o700)
}

type Lock struct{ file *os.File }

func (l *Lock) Close() error {
	if l == nil || l.file == nil {
		return nil
	}
	err := syscall.Flock(int(l.file.Fd()), syscall.LOCK_UN)
	closeErr := l.file.Close()
	l.file = nil
	if err != nil {
		return err
	}
	return closeErr
}

func (s *Store) lock(name string, flags int) (*Lock, error) {
	path := filepath.Join(s.Home, name)
	if info, err := os.Lstat(path); err == nil && (!info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0) {
		return nil, fmt.Errorf("release lock %q is not a regular file", name)
	} else if err != nil && !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	f, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR|syscall.O_NOFOLLOW, 0o600)
	if err != nil {
		return nil, err
	}
	if err := syscall.Flock(int(f.Fd()), flags); err != nil {
		f.Close()
		return nil, err
	}
	return &Lock{f}, nil
}

// SelectionLock protects active resolution through candidate readiness. Update,
// rollback and uninstall use an exclusive lock; start uses shared.
func (s *Store) SelectionLock(exclusive bool) (*Lock, error) {
	flags := syscall.LOCK_SH
	if exclusive {
		flags = syscall.LOCK_EX
	}
	return s.lock("selection.lock", flags)
}

// TransitionLock serializes durable lifecycle transitions independently from
// process ownership. Callers take it before the exclusive selection lock.
func (s *Store) TransitionLock() (*Lock, error) { return s.lock("transition.lock", syscall.LOCK_EX) }

func (s *Store) ReadActive() (Active, error) {
	var active Active
	if err := readStrictRegular(filepath.Join(s.Home, ActiveFile), &active); err != nil {
		return active, err
	}
	if active.SchemaVersion != 1 || active.Generation == 0 || !active.Receipt.Valid() || active.SelectorBuildID == "" || !validAcquisition(active.Acquisition) {
		return active, errors.New("invalid active release record")
	}
	return active, nil
}

func (s *Store) WriteActive(receipt Receipt, prior uint64) (Active, error) {
	return s.WriteSelectedActive(receipt, prior, receipt.BuildID, "")
}

// WriteSelectedActive is the sole selected-pair write. SelectorBuildID names
// the immutable launcher copied into bin/jobctrl and must be compatible with
// Receipt; Acquisition describes the mutable acquisition adapter only.
func (s *Store) WriteSelectedActive(receipt Receipt, prior uint64, selectorBuildID, acquisition string) (Active, error) {
	if !receipt.Valid() {
		return Active{}, errors.New("invalid release receipt for activation")
	}
	if selectorBuildID == "" || !validAcquisition(acquisition) {
		return Active{}, errors.New("missing selector build identity")
	}
	active := Active{SchemaVersion: 1, Generation: prior + 1, Receipt: receipt, SelectorBuildID: selectorBuildID, Acquisition: acquisition}
	if active.Generation == 0 {
		active.Generation = 1
	}
	if err := writeAtomic(filepath.Join(s.Home, ActiveFile), active); err != nil {
		return Active{}, err
	}
	return active, nil
}

func validAcquisition(value string) bool {
	// Empty is read-only migration state for P5 records written before
	// acquisition ownership moved out of immutable receipts. New installers
	// always write one of the explicit adapters below.
	return value == "" || value == "curl" || value == "homebrew" || value == "local-fixture"
}

func (s *Store) ReadJournal() (Journal, error) {
	var journal Journal
	if err := readStrictRegular(filepath.Join(s.Home, JournalFile), &journal); err != nil {
		return journal, err
	}
	if journal.SchemaVersion != 1 || journal.ID == "" || journal.Operation == "" || journal.State == "" {
		return journal, errors.New("invalid release transition journal")
	}
	return journal, nil
}

func (s *Store) Begin(operation string, old, candidate *Receipt, descriptorDigest string) (Journal, error) {
	if operation == "" || (descriptorDigest != "" && !digestPattern.MatchString(descriptorDigest)) {
		return Journal{}, errors.New("invalid release transition identity")
	}
	id, err := randomID()
	if err != nil {
		return Journal{}, err
	}
	j := Journal{SchemaVersion: 1, ID: id, Operation: operation, State: Idle, Old: old, Candidate: candidate, DescriptorSHA256: descriptorDigest, UpdatedAt: time.Now().UTC()}
	return j, s.writeJournal(j)
}

func (s *Store) Advance(j *Journal, state State, cause error) error {
	if j == nil || j.SchemaVersion != 1 || j.ID == "" {
		return errors.New("invalid transition journal")
	}
	j.State, j.UpdatedAt = state, time.Now().UTC()
	if cause != nil {
		j.Error = cause.Error()
	}
	return s.writeJournal(*j)
}
func (s *Store) writeJournal(j Journal) error {
	return writeAtomic(filepath.Join(s.Home, JournalFile), j)
}

// StageDir names staging solely by authenticated descriptor bytes. An
// interrupted download therefore resumes only when it has exactly the same
// descriptor digest; unrelated staging is never adopted.
func (s *Store) StageDir(descriptorDigest string) (string, error) {
	if !digestPattern.MatchString(descriptorDigest) {
		return "", errors.New("invalid descriptor digest")
	}
	return filepath.Join(s.Home, "staging", descriptorDigest), nil
}

func readStrictRegular(path string, dst any) error {
	info, err := os.Lstat(path)
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
		return fmt.Errorf("%s is not a regular file", filepath.Base(path))
	}
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	d := json.NewDecoder(f)
	d.DisallowUnknownFields()
	if err := d.Decode(dst); err != nil {
		return err
	}
	if err := d.Decode(&struct{}{}); err != io.EOF {
		return errors.New("trailing JSON value")
	}
	return nil
}
func writeAtomic(path string, value any) error {
	raw, err := json.Marshal(value)
	if err != nil {
		return err
	}
	raw = append(raw, '\n')
	random, err := randomID()
	if err != nil {
		return err
	}
	tmp := filepath.Join(filepath.Dir(path), "."+filepath.Base(path)+"."+random)
	f, err := os.OpenFile(tmp, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return err
	}
	if _, err = f.Write(raw); err == nil {
		err = f.Sync()
	}
	if closeErr := f.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		_ = os.Remove(tmp)
		return err
	}
	if info, err := os.Lstat(path); err == nil && (!info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0) {
		_ = os.Remove(tmp)
		return fmt.Errorf("managed file %q is not regular", filepath.Base(path))
	} else if err != nil && !errors.Is(err, os.ErrNotExist) {
		_ = os.Remove(tmp)
		return err
	}
	if err := os.Rename(tmp, path); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	d, err := os.Open(filepath.Dir(path))
	if err != nil {
		return err
	}
	defer d.Close()
	return d.Sync()
}
func randomID() (string, error) {
	raw := make([]byte, 16)
	if _, err := rand.Read(raw); err != nil {
		return "", err
	}
	return hex.EncodeToString(raw), nil
}
func Digest(raw []byte) string { sum := sha256.Sum256(raw); return hex.EncodeToString(sum[:]) }
