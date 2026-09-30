package config

import (
	"path/filepath"
	"testing"
)

func newTestConfig(t *testing.T) {
	t.Helper()
	if err := Init(filepath.Join(t.TempDir(), "config.json")); err != nil {
		t.Fatalf("Init: %v", err)
	}
}

func TestProxyEntryURL(t *testing.T) {
	plain := ProxyEntry{Host: "host.example", Port: 8080, Scheme: "http"}
	if got, want := plain.URL(), "http://host.example:8080"; got != want {
		t.Fatalf("plain URL = %q, want %q", got, want)
	}

	auth := ProxyEntry{Host: "host.example", Port: 1080, Scheme: "socks5", Username: "u", Password: "p"}
	if got, want := auth.URL(), "socks5://u:p@host.example:1080"; got != want {
		t.Fatalf("auth URL = %q, want %q", got, want)
	}

	// A missing scheme defaults to http; a missing host yields nothing so the
	// entry can never become a dialable-but-empty proxy.
	def := ProxyEntry{Host: "h", Port: 1}
	if got, want := def.URL(), "http://h:1"; got != want {
		t.Fatalf("default scheme URL = %q, want %q", got, want)
	}
	if got := (ProxyEntry{Port: 1}).URL(); got != "" {
		t.Fatalf("empty host URL = %q, want empty", got)
	}
}

func TestProxyInventoryCRUD(t *testing.T) {
	newTestConfig(t)

	if got := GetProxies(); len(got) != 0 {
		t.Fatalf("fresh inventory = %d entries, want 0", len(got))
	}

	added, err := AddProxy(ProxyEntry{Country: "ID", Host: "a.example", Port: 8080, Scheme: "http", Enabled: true})
	if err != nil {
		t.Fatalf("AddProxy: %v", err)
	}
	if added.ID == "" {
		t.Fatal("AddProxy did not assign an id")
	}

	if got := GetProxies(); len(got) != 1 || got[0].Host != "a.example" {
		t.Fatalf("after add = %+v, want one a.example entry", got)
	}

	if err := SetProxyEnabled(added.ID, false); err != nil {
		t.Fatalf("SetProxyEnabled: %v", err)
	}
	if got := GetProxies()[0].Enabled; got {
		t.Fatal("entry still enabled after SetProxyEnabled(false)")
	}

	if err := SetProxyEnabled("missing", true); err != errProxyNotFound {
		t.Fatalf("SetProxyEnabled(missing) = %v, want errProxyNotFound", err)
	}
	if err := RemoveProxy("missing"); err != errProxyNotFound {
		t.Fatalf("RemoveProxy(missing) = %v, want errProxyNotFound", err)
	}

	if err := RemoveProxy(added.ID); err != nil {
		t.Fatalf("RemoveProxy: %v", err)
	}
	if got := GetProxies(); len(got) != 0 {
		t.Fatalf("after remove = %d entries, want 0", len(got))
	}
}

func TestEnabledProxyURLsSkipsDisabledAndDuplicates(t *testing.T) {
	newTestConfig(t)

	mustAdd := func(e ProxyEntry) {
		t.Helper()
		if _, err := AddProxy(e); err != nil {
			t.Fatalf("AddProxy(%+v): %v", e, err)
		}
	}
	mustAdd(ProxyEntry{Host: "one", Port: 1, Scheme: "http", Enabled: true})
	mustAdd(ProxyEntry{Host: "two", Port: 2, Scheme: "http", Enabled: false}) // disabled
	mustAdd(ProxyEntry{Host: "one", Port: 1, Scheme: "http", Enabled: true})  // duplicate URL

	urls := EnabledProxyURLs()
	if len(urls) != 1 || urls[0] != "http://one:1" {
		t.Fatalf("EnabledProxyURLs = %v, want exactly [http://one:1]", urls)
	}
}

func TestAccountProxyURLPrefersAccountOverride(t *testing.T) {
	newTestConfig(t)
	t.Setenv("KIRO_ACCOUNT_PROXIES", "")
	if _, err := AddProxy(ProxyEntry{Host: "inv", Port: 9, Scheme: "http", Enabled: true}); err != nil {
		t.Fatalf("AddProxy: %v", err)
	}

	account := &Account{ID: "acct-1", ProxyURL: "http://explicit:7777"}
	if got, want := AccountProxyURL(account), "http://explicit:7777"; got != want {
		t.Fatalf("AccountProxyURL = %q, want the account override %q", got, want)
	}
}

func TestAccountProxyURLUsesInventoryStably(t *testing.T) {
	newTestConfig(t)
	t.Setenv("KIRO_ACCOUNT_PROXIES", "")

	var pool []string
	for _, host := range []string{"p1", "p2", "p3"} {
		saved, err := AddProxy(ProxyEntry{Host: host, Port: 1080, Scheme: "http", Enabled: true})
		if err != nil {
			t.Fatalf("AddProxy: %v", err)
		}
		pool = append(pool, saved.URL())
	}

	account := &Account{ID: "acct-stable"}
	first := AccountProxyURL(account)
	if !contains(pool, first) {
		t.Fatalf("AccountProxyURL = %q, not one of the inventory %v", first, pool)
	}
	// Stability: the same account must keep the same exit on every call.
	for i := 0; i < 20; i++ {
		if got := AccountProxyURL(account); got != first {
			t.Fatalf("AccountProxyURL drifted: %q != %q", got, first)
		}
	}
}

func TestAccountProxyURLFallsBackToGlobalWhenInventoryDisabled(t *testing.T) {
	newTestConfig(t)
	t.Setenv("KIRO_ACCOUNT_PROXIES", "")
	if _, err := AddProxy(ProxyEntry{Host: "dis", Port: 1, Scheme: "http", Enabled: false}); err != nil {
		t.Fatalf("AddProxy: %v", err)
	}
	if err := UpdateProxySettings("http://global:3128"); err != nil {
		t.Fatalf("UpdateProxySettings: %v", err)
	}
	t.Cleanup(func() { _ = UpdateProxySettings("") })

	if got, want := AccountProxyURL(&Account{ID: "acct-x"}), "http://global:3128"; got != want {
		t.Fatalf("AccountProxyURL = %q, want the global proxy %q (disabled inventory must be ignored)", got, want)
	}
}

func contains(haystack []string, needle string) bool {
	for _, s := range haystack {
		if s == needle {
			return true
		}
	}
	return false
}
