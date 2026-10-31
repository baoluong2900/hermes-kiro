package proxy

import (
	"os"
	"path/filepath"
	"testing"

	"kiro-go/config"
)

// TestMain gives the package a usable global config before any test runs.
//
// Several accessors (config.GetProxyURL and friends) read the package-level
// config struct directly, so calling into the proxy with no config at all is a
// nil dereference. Most tests happen to run after one that called config.Init,
// which hid the gap — until `go test -shuffle=on` put one of the
// ResolveProfileArn / DiscoverKiroProfiles tests first and the package paniced.
// Initializing once here makes the suite order-independent; tests that need
// their own config still call config.Init with their own temp file.
func TestMain(m *testing.M) {
	dir, err := os.MkdirTemp("", "kiro-proxy-tests")
	if err != nil {
		panic("create test config dir: " + err.Error())
	}
	if err := config.Init(filepath.Join(dir, "config.json")); err != nil {
		panic("init test config: " + err.Error())
	}
	code := m.Run()
	_ = os.RemoveAll(dir)
	os.Exit(code)
}
