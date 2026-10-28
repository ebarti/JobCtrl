//go:build darwin

package launcher

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"
)

func TestApplyCensusObservationDiagnosticsPreserveAcceptance(t *testing.T) {
	tests := []struct {
		name, raw, want string
		readErr         error
	}{
		{name: "read", raw: `{"session_id":1,"outcome":"verified","samples":[{}]}`, readErr: errors.New("/Users/synthetic/private-file"), want: "could not be read"},
		{name: "json", raw: `{`, want: "invalid JSON"},
		{name: "schema", raw: `{"session_id":"invalid","outcome":"verified","samples":[{}]}`, want: "invalid schema"},
		{name: "identity", raw: `{"session_id":0,"outcome":"verified","samples":[{}]}`, want: "invalid session identity"},
		{name: "empty", raw: `{"session_id":1,"outcome":"verified","samples":[]}`, want: "no samples"},
		{name: "outcome", raw: `{"session_id":1,"outcome":"unknown","samples":[{}]}`, want: "invalid outcome"},
		{name: "refused", raw: `{"session_id":1,"outcome":"refused","samples":[{}]}`, want: "census refused"},
		{name: "verified", raw: `{"session_id":1,"outcome":"verified","samples":[{"complete":true}]}`},
		// The existing assertion only requires a nonempty samples array; it
		// does not impose new sample schemas on a verified observation.
		{name: "verified arbitrary sample", raw: `{"session_id":1,"outcome":"verified","samples":[null]}`},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			var old struct {
				SessionID int               `json:"session_id"`
				Outcome   string            `json:"outcome"`
				Samples   []json.RawMessage `json:"samples"`
			}
			oldAccepted := tc.readErr == nil && json.Unmarshal([]byte(tc.raw), &old) == nil &&
				old.SessionID > 0 && len(old.Samples) > 0 && old.Outcome == "verified"
			diagnostic := describeApplyCensusObservation([]byte(tc.raw), tc.readErr)
			if (diagnostic == "") != oldAccepted {
				t.Fatal("diagnostic changed the existing pass/fail predicate")
			}
			if tc.want != "" && !strings.Contains(diagnostic, tc.want) {
				t.Fatalf("wrong diagnostic category: %s", diagnostic)
			}
			if strings.Contains(diagnostic, "/Users/synthetic/private-file") {
				t.Fatal("diagnostic exposed a local path")
			}
		})
	}
}

func TestApplyCensusRefusalDiagnosticsContainOnlyAggregates(t *testing.T) {
	raw := []byte(`{"session_id":7654321,"outcome":"refused","samples":[
		{"complete":false,"inventory_changes":2,"session_members":[8765432]},
		{"complete":true,"inventory_changes":0,"session_members":[]},
		{"error":"/Users/synthetic/private-file"},"invalid-sample"]}`)
	got := describeApplyCensusObservation(raw, nil)
	want := "native process-session census refused: samples=4 complete=1 incomplete=1 unknown=2 changed_samples=1 occupied_samples=1 error_samples=1 malformed_samples=1"
	if got != want {
		t.Fatalf("unexpected aggregate diagnostic: %s", got)
	}
	for _, secret := range []string{"7654321", "8765432", "/Users/synthetic/private-file"} {
		if strings.Contains(got, secret) {
			t.Fatal("diagnostic exposed a process identity or local path")
		}
	}
}
