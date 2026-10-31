package proxy

import (
	"kiro-go/config"
	accountpool "kiro-go/pool"
	"path/filepath"
	"testing"
)

// initTestConfigFile points the global config at a throwaway config.json inside
// the test's temp dir and returns its path.
//
// It also drains the pool's async stat-save goroutines during cleanup.
// pool.UpdateStats persists account stats on a detached goroutine, so a request
// served during the test can rewrite config.json AFTER the test body returned:
//
//   - t.TempDir's cleanup removes the directory, the late write recreates
//     config.json inside it, and the removal fails with "directory not empty"
//     in whichever test loses the race.
//   - the late write resolves the global config path at write time, so it can
//     also clobber the config a following test just initialized.
//
// t.Cleanup runs LIFO and t.TempDir registers its removal when called, so the
// drain registered after it always runs before the directory is removed.
func initTestConfigFile(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	drainStatSavesOnCleanup(t)

	path := filepath.Join(dir, "config.json")
	if err := config.Init(path); err != nil {
		t.Fatalf("config.Init(%s): %v", path, err)
	}
	return path
}

// drainStatSavesOnCleanup registers the stat-save drain for a test that builds
// its own temp config path. Call it after t.TempDir() so the drain runs first.
func drainStatSavesOnCleanup(t *testing.T) {
	t.Helper()
	t.Cleanup(accountpool.WaitForStatSaves)
}
