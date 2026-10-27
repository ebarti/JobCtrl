package installer

// This file contains the locked, forward-only selection handoff. It is not an
// acquisition entry point: callers must authenticate both immutable releases,
// the bridge role, policy, inventory and controller bytes before supplying an
// evidence verifier. In particular, a protocol number alone is not authority.
import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"math"
	"os"
	"path/filepath"
	"syscall"

	"github.com/ebarti/jobctrl/launcher/internal/release"
)

const bridgeIntentName = "bridge-handoff.json"
const maxBridgeIntentBytes = maxDescriptorBytes + maxSignatureBytes

type bridgeHandoffIntent struct {
	SchemaVersion        int                     `json:"schemaVersion"`
	Source               release.Active          `json:"source"`
	Target               release.Receipt         `json:"target"`
	SourceSelectorSHA256 string                  `json:"sourceSelectorSha256"`
	ControllerSHA256     string                  `json:"controllerSha256"`
	EvidenceSHA256       string                  `json:"evidenceSha256,omitempty"`
	Metadata             release.ChannelMetadata `json:"metadata"`
}

type bridgeHandoffEvidence struct {
	Intent     bridgeHandoffIntent
	Controller []byte
	// Verify must reauthenticate all evidence and the installed releases under
	// the release locks. It is mandatory, including for forward recovery.
	Verify func() error
	// Persist durably retains authenticated evidence while both locks are held,
	// before the handoff intent is written and any active record can change.
	Persist func() error
}

func bridgeSelection(store *release.Store, evidence bridgeHandoffEvidence, checkpoint func(string) error) error {
	transition, err := store.TransitionLock()
	if err != nil {
		return err
	}
	defer transition.Close()
	return bridgeSelectionWithTransition(store, evidence, checkpoint)
}

// bridgeSelectionWithTransition requires the caller to hold the transition lock.
func bridgeSelectionWithTransition(store *release.Store, evidence bridgeHandoffEvidence, checkpoint func(string) error) error {
	if evidence.Verify == nil {
		return errors.New("bridge verification is required")
	}
	if len(evidence.Controller) == 0 || len(evidence.Controller) > 128<<20 {
		return errors.New("invalid authenticated bridge controller size")
	}
	intent := evidence.Intent
	if intent.EvidenceSHA256 != "" && (!sha256Pattern.MatchString(intent.EvidenceSHA256) || evidence.Persist == nil) {
		return errors.New("invalid durable bridge evidence")
	}
	// Capture caller-owned data before verification and preserve the exact
	// bytes throughout the locked mutation. The verifier may retain its own
	// references and must not be able to change these after admission.
	intent.Metadata.Revoked = append([]string(nil), intent.Metadata.Revoked...)
	controller := append([]byte(nil), evidence.Controller...)
	if intent.SchemaVersion != 1 || !intent.Target.Valid() || intent.Source.Generation == 0 || intent.Source.Generation == math.MaxUint64 || !intent.Source.Receipt.Valid() || !sha256Pattern.MatchString(intent.SourceSelectorSHA256) || !sha256Pattern.MatchString(intent.ControllerSHA256) || len(controller) == 0 || len(controller) > 128<<20 || digestBytes(controller) != intent.ControllerSHA256 {
		return errors.New("invalid authenticated bridge selection")
	}
	if intent.Metadata.Channel != intent.Target.Channel || intent.Metadata.BuildID != intent.Target.BuildID || intent.Metadata.Sequence != intent.Target.Sequence || intent.Metadata.DescriptorDigest != intent.Target.DescriptorSHA256 {
		return errors.New("bridge policy does not match target")
	}
	selection, err := store.SelectionLock(true)
	if err != nil {
		return err
	}
	defer selection.Close()
	if err := evidence.Verify(); err != nil {
		return fmt.Errorf("verify bridge evidence: %w", err)
	}
	journal, err := store.ReadJournal()
	if err == nil {
		switch journal.State {
		case release.Idle, release.Promoted, release.RolledBack, release.Failed:
		default:
			return errors.New("unfinished release transition prevents bridge handoff")
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("read release transition: %w", err)
	}
	if _, err := store.ValidateMetadata(intent.Metadata); err != nil {
		return fmt.Errorf("bridge channel policy: %w", err)
	}
	target := release.Active{SchemaVersion: 1, Generation: intent.Source.Generation + 1, Receipt: intent.Target, SelectorBuildID: intent.Target.BuildID, Acquisition: intent.Source.Acquisition}
	path := filepath.Join(store.Home, bridgeIntentName)
	raw, err := readBoundedFile(path, maxBridgeIntentBytes)
	if errors.Is(err, os.ErrNotExist) {
		active, e := store.ReadActive()
		if e != nil {
			return e
		}
		if active == target {
			if err := verifyBridgeSelector(store.Home, intent.ControllerSHA256); err != nil {
				return err
			}
			if intent.EvidenceSHA256 != "" {
				if err := verifyBridgeCompletion(store.Home, intent); err != nil {
					return err
				}
			}
			state, err := store.ValidateMetadata(intent.Metadata)
			if err != nil {
				return err
			}
			return store.CommitMetadata(state)
		}
		if active != intent.Source {
			return errors.New("bridge source selection changed")
		}
		if err := verifyBridgeSelector(store.Home, intent.SourceSelectorSHA256); err != nil {
			return err
		}
		if evidence.Persist != nil {
			if err := evidence.Persist(); err != nil {
				return fmt.Errorf("persist bridge evidence: %w", err)
			}
		}
		encoded, e := encodeJSON(intent)
		if e != nil {
			return e
		}
		if len(encoded) > maxBridgeIntentBytes {
			return errors.New("bridge handoff intent exceeds size limit")
		}
		if e := writeBytesAtomic(path, encoded, 0600); e != nil {
			return e
		}
	} else if err != nil {
		return err
	} else {
		var stored bridgeHandoffIntent
		if err := decodeStrict(raw, "bridge handoff intent", &stored); err != nil {
			return err
		}
		// ChannelMetadata contains a slice; compare its deterministic encoding.
		expected, _ := encodeJSON(intent)
		observed, _ := encodeJSON(stored)
		if !bytes.Equal(expected, observed) {
			return errors.New("bridge handoff intent does not match verified request")
		}
	}
	if checkpoint != nil {
		if err := checkpoint("intent"); err != nil {
			return err
		}
	}
	active, err := store.ReadActive()
	if err != nil {
		return err
	}
	if active == intent.Source {
		if err := verifyBridgeSelector(store.Home, intent.SourceSelectorSHA256); err != nil {
			return err
		}
		if _, err := store.WriteSelectedActive(intent.Target, intent.Source.Generation, intent.Target.BuildID, intent.Source.Acquisition); err != nil {
			return err
		}
	} else if active != target {
		return errors.New("bridge active selection changed")
	}
	if checkpoint != nil {
		if err := checkpoint("active"); err != nil {
			return err
		}
	}
	// A retained intent permits only the authenticated old selector or the
	// authenticated new selector. Unknown intervening bytes are not ours to
	// overwrite, even after the active receipt has moved forward.
	if verifyBridgeSelector(store.Home, intent.SourceSelectorSHA256) != nil && verifyBridgeSelector(store.Home, intent.ControllerSHA256) != nil {
		return errors.New("bridge selector changed during handoff")
	}
	// Once the v14 protocol-2 receipt is active, old controllers fail closed.
	// Policy finalization and selector repair therefore move forward only.
	state, err := store.ValidateMetadata(intent.Metadata)
	if err != nil {
		return err
	}
	if err := store.CommitMetadata(state); err != nil {
		return err
	}
	if checkpoint != nil {
		if err := checkpoint("policy"); err != nil {
			return err
		}
	}
	if err := installVerifiedBridgeSelector(store.Home, controller); err != nil {
		return err
	}
	if checkpoint != nil {
		if err := checkpoint("selector"); err != nil {
			return err
		}
	}
	if err := verifyBridgeSelector(store.Home, intent.ControllerSHA256); err != nil {
		return err
	}
	// Preserve an authenticated route back to the original source selection
	// after the intent is removed, so a retry can reverify the same evidence.
	if intent.EvidenceSHA256 != "" {
		if err := writeBridgeCompletion(store.Home, intent); err != nil {
			return err
		}
	}
	if err := os.Remove(path); err != nil {
		return err
	}
	return syncDirectory(store.Home)
}

func verifyBridgeCompletion(home string, intent bridgeHandoffIntent) error {
	path := bridgeCompletionPath(home, intent)
	raw, err := readBoundedFile(path, maxBridgeIntentBytes)
	if err != nil {
		return fmt.Errorf("read completed bridge handoff: %w", err)
	}
	var stored bridgeHandoffIntent
	if err := decodeStrict(raw, "completed bridge handoff", &stored); err != nil {
		return err
	}
	expected, _ := encodeJSON(intent)
	observed, _ := encodeJSON(stored)
	if !bytes.Equal(expected, observed) {
		return errors.New("completed bridge handoff does not match verified request")
	}
	return nil
}

func writeBridgeCompletion(home string, intent bridgeHandoffIntent) error {
	path := bridgeCompletionPath(home, intent)
	if _, err := os.Lstat(path); err == nil {
		return verifyBridgeCompletion(home, intent)
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	encoded, err := encodeJSON(intent)
	if err != nil {
		return err
	}
	return writeBytesAtomic(path, encoded, 0600)
}

func bridgeCompletionPath(home string, intent bridgeHandoffIntent) string {
	encoded, _ := encodeJSON(intent)
	return filepath.Join(home, "bridge-complete-"+intent.EvidenceSHA256+"-"+digestBytes(encoded)+".json")
}

func verifyBridgeSelector(home, expected string) error {
	path := filepath.Join(home, "bin", "jobctrl")
	file, err := os.OpenFile(path, os.O_RDONLY|syscall.O_NOFOLLOW, 0)
	if err != nil {
		return errors.New("bridge selector is not a regular executable")
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Mode()&0111 == 0 || info.Size() > 128<<20 {
		return errors.New("bridge selector is not a regular executable")
	}
	raw, err := io.ReadAll(io.LimitReader(file, (128<<20)+1))
	if err != nil || digestBytes(raw) != expected {
		return errors.New("bridge selector identity changed")
	}
	return nil
}

func installVerifiedBridgeSelector(home string, controller []byte) error {
	bin := filepath.Join(home, "bin")
	if err := ensureManagedDirectory(bin); err != nil {
		return err
	}
	return writeBytesAtomic(filepath.Join(bin, "jobctrl"), controller, 0755)
}
