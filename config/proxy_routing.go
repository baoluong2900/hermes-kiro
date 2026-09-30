package config

import (
	"hash/fnv"
	"net/url"
	"os"
	"strings"
)

// AccountProxyURL chooses one stable exit per account so token refresh and Kiro
// requests use the same network identity. An explicit account proxy always wins.
// KIRO_ACCOUNT_PROXIES is a semicolon-separated list of COUNTRY|URL entries,
// e.g. ID|http://user:pass@host:port;VN|http://user:pass@host:port.
// ID entries take precedence over VN entries; other countries are ignored.
// If no valid regional entry exists, the configured global proxy is used.
func AccountProxyURL(account *Account) string {
	if account != nil && account.ProxyURL != "" {
		return account.ProxyURL
	}
	if account == nil || strings.TrimSpace(account.ID) == "" {
		return GetProxyURL()
	}

	var indonesia, vietnam []string
	for _, entry := range strings.Split(os.Getenv("KIRO_ACCOUNT_PROXIES"), ";") {
		parts := strings.SplitN(strings.TrimSpace(entry), "|", 2)
		if len(parts) != 2 {
			continue
		}
		raw := strings.TrimSpace(parts[1])
		parsed, err := url.Parse(raw)
		if err != nil || parsed.Hostname() == "" || parsed.Port() == "" {
			continue
		}
		switch strings.ToLower(parsed.Scheme) {
		case "http", "https", "socks5", "socks5h":
		default:
			continue
		}
		switch strings.ToUpper(strings.TrimSpace(parts[0])) {
		case "ID":
			indonesia = append(indonesia, raw)
		case "VN":
			vietnam = append(vietnam, raw)
		}
	}

	candidates := indonesia
	if len(candidates) == 0 {
		candidates = vietnam
	}
	if len(candidates) == 0 {
		return GetProxyURL()
	}
	h := fnv.New64a()
	_, _ = h.Write([]byte(account.ID))
	return candidates[h.Sum64()%uint64(len(candidates))]
}
