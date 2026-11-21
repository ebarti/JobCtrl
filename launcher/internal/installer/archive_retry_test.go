package installer

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

// Exercise the real acquisition path across separate invocations of the installer.
func TestManualArchiveRetry(t *testing.T) {
	good := []byte("correct archive bytes")
	bad := make([]byte, len(good))
	for _, name := range []string{"download", partialArchiveName, stagedArchiveName} {
		t.Run(name, func(t *testing.T) {
			stage := t.TempDir()
			requests := 0
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				requests++
				if name == "download" && requests == 1 {
					_, _ = w.Write(bad)
					return
				}
				_, _ = w.Write(good)
			}))
			defer server.Close()
			if name != "download" {
				if err := os.WriteFile(filepath.Join(stage, name), bad, 0600); err != nil {
					t.Fatal(err)
				}
			}
			acquire := func() (string, error) {
				return downloadArchiveToStage(server.Client(), server.URL, int64(len(good)), digestBytes(good), stage)
			}
			if _, err := acquire(); !errors.Is(err, errArchiveMismatch) {
				t.Fatalf("expected a verified mismatch, got %v", err)
			}
			previousRequests := requests
			path, err := acquire()
			if err != nil || requests != previousRequests+1 {
				t.Fatalf("manual retry: requests=%d, err=%v", requests, err)
			}
			received, err := os.ReadFile(path)
			if err != nil || string(received) != string(good) {
				t.Fatalf("retried archive did not contain the verified bytes: %v", err)
			}
			if _, err := acquire(); err != nil || requests != previousRequests+1 {
				t.Fatalf("verified cache was not reused: %v", err)
			}
		})
	}
}
