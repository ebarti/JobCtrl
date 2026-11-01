//go:build !darwin

package launcher

import "github.com/ebarti/jobctrl/launcher/internal/release"

func releaseQACheckpoint(_ *release.Store, _ release.State) error { return nil }
