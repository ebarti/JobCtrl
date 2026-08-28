package launcher

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestShippedRuntimeContractsSupportCompiledLauncherProtocol(t *testing.T) {
	t.Helper()
	_, sourceFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("resolve test source path")
	}
	repositoryRoot := filepath.Clean(filepath.Join(filepath.Dir(sourceFile), "..", "..", ".."))

	runtimeContract, err := loadRuntimeManifest(filepath.Join(repositoryRoot, "launcher", "runtime-manifest.json"))
	if err != nil {
		t.Fatalf("load shipped runtime manifest: %v", err)
	}
	if runtimeContract.LauncherProtocol != launcherProtocol {
		t.Fatalf(
			"shipped runtime protocol = %d, compiled launcher protocol = %d",
			runtimeContract.LauncherProtocol,
			launcherProtocol,
		)
	}

	rawPlatforms, err := os.ReadFile(filepath.Join(repositoryRoot, "packaging", "distribution", "platforms.json"))
	if err != nil {
		t.Fatalf("read shipped platform contracts: %v", err)
	}
	var platformContracts struct {
		Platforms []struct {
			ID                    string `json:"id"`
			LauncherCompatibility struct {
				Minimum int `json:"minimum"`
				Maximum int `json:"maximum"`
			} `json:"launcherCompatibility"`
		} `json:"platforms"`
	}
	if err := json.Unmarshal(rawPlatforms, &platformContracts); err != nil {
		t.Fatalf("decode shipped platform contracts: %v", err)
	}
	if len(platformContracts.Platforms) == 0 {
		t.Fatal("shipped platform contracts are empty")
	}
	for _, platform := range platformContracts.Platforms {
		if platform.LauncherCompatibility.Minimum > launcherProtocol ||
			platform.LauncherCompatibility.Maximum < launcherProtocol {
			t.Errorf(
				"platform %q supports launcher protocol %d-%d, compiled launcher protocol = %d",
				platform.ID,
				platform.LauncherCompatibility.Minimum,
				platform.LauncherCompatibility.Maximum,
				launcherProtocol,
			)
		}
	}
}
