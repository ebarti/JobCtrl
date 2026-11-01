package launcher

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

func TestBuildSealedV15CandidateDispatchesEveryAdmittedSource(t *testing.T) {
	for _, sourceVersion := range []int64{6, 7, 8, 9, 10, 11, 12, 13, 14} {
		t.Run("source-v"+strconv.FormatInt(sourceVersion, 10), func(t *testing.T) {
			previous := v15SourceBinder
			v15SourceBinder = func(launchContext, string, string) error { return nil }
			t.Cleanup(func() { v15SourceBinder = previous })
			ctx, pair, _, argsPath := fakeV10BuilderContext(t, sourceVersion)
			python := filepath.Join(ctx.PayloadRoot, "python", "bin", "python3")
			script := `#!/bin/sh
set -eu
if [ "$3" = "-m" ]; then
  [ "$4" = "jobctrl.infrastructure.migrations.legacy_to_v15_execute" ] || exit 41
  printf '%s\n' "$@" > "$JOBCTRL_TEST_ARGUMENTS"
  candidate=""; previous=""
  for argument in "$@"; do
    if [ "$previous" = "--candidate" ]; then candidate="$argument"; fi
    previous="$argument"
  done
  umask 077
  printf '%s' "$JOBCTRL_TEST_CANDIDATE" > "$candidate"
  printf '%s\n' "$JOBCTRL_TEST_RECEIPT"
  exit 0
fi
if [ "$3" = "-c" ]; then printf '15\n'; exit 0; fi
exit 43
`
			if err := os.WriteFile(python, []byte(script), 0o755); err != nil {
				t.Fatal(err)
			}
			candidateBytes := "sealed exact-v15 candidate"
			digest := sha256.Sum256([]byte(candidateBytes))
			receipt, err := json.Marshal(sealedV15CandidateReceipt{CandidateDataDigest: strings.Repeat("a", 64), CandidateSHA256: hex.EncodeToString(digest[:]), JobCount: 1, SchemaVersion: 1, SourceDataDigest: strings.Repeat("a", 64), Status: "ready", TableCount: 130, UserVersion: 15})
			if err != nil {
				t.Fatal(err)
			}
			ctx.Environment = []string{"JOBCTRL_TEST_ARGUMENTS=" + argsPath, "JOBCTRL_TEST_CANDIDATE=" + candidateBytes, "JOBCTRL_TEST_RECEIPT=" + string(receipt)}
			const id = "v15-dispatch"
			candidate, err := buildSealedV15Candidate(ctx, pair, id)
			if err != nil || candidate != v15CandidatePath(ctx.Instance.StateDir, id) {
				t.Fatalf("candidate=%q err=%v", candidate, err)
			}
			arguments, err := os.ReadFile(argsPath)
			if err != nil {
				t.Fatal(err)
			}
			if !strings.Contains(string(arguments), "--source-version\n"+strconv.FormatInt(sourceVersion, 10)) {
				t.Fatalf("wrong arguments %s", arguments)
			}
			if strings.Contains(string(arguments), "--migration-at") != (sourceVersion == 6) {
				t.Fatalf("migration-at mismatch %s", arguments)
			}
			cleanupV15Candidate(ctx.Instance.StateDir, id)
			if _, err := os.Lstat(candidate); !errors.Is(err, os.ErrNotExist) {
				t.Fatalf("candidate remains: %v", err)
			}
		})
	}
}

func TestV15PreservationIntentRecognizesLegacyAndRejectsAmbiguous(t *testing.T) {
	dir := t.TempDir()
	const journal = "migration-journal"
	const backup = "backup"
	if err := writeV14SourcePreservation(dir, journal, backup, 13); err != nil {
		t.Fatal(err)
	}
	intent, legacy, err := readMigrationSourcePreservation(dir, journal)
	if err != nil || !legacy || intent == nil || intent.SourceVersion != 13 {
		t.Fatalf("legacy intent=%+v legacy=%v err=%v", intent, legacy, err)
	}
	if err := writeV15SourcePreservation(dir, journal, backup, 13); err != nil {
		t.Fatal(err)
	}
	if _, _, err := readMigrationSourcePreservation(dir, journal); err == nil {
		t.Fatal("ambiguous preservation intents accepted")
	}
}
