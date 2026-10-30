//go:build !darwin && !linux

package retentionfs

import "testing"

func TestUnsupportedPlatformRefusesRetention(t *testing.T) {
	if root, err := Open("ignored", nil, nil); root != nil || err == nil {
		t.Fatalf("unsupported retention must refuse: root=%v err=%v", root, err)
	}
}
