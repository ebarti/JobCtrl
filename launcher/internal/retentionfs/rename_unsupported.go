//go:build linux && !amd64 && !arm64

package retentionfs

import "errors"

func renameExclusive(_ uintptr, _, _ string) error {
	return errors.New("race-safe release retention is unavailable on this platform")
}
