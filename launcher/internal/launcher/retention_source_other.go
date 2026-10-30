//go:build !darwin

package launcher

import (
	"errors"
	"os"
)

func verifyRetentionSourceAuthority(*retentionReferenceAuthority, *os.Root, string, string, instanceState) error {
	return errors.New("source runtime authority is unavailable on this platform")
}
