package proxy

import (
	"sync"
	"time"
)

// Conversation → account affinity.
//
// The only prompt cache that cuts credits is Kiro's server-side prefix cache,
// and it lives per account (see docs/kiro-prompt-cache-agentic-audit.md): a
// conversation that hops to another account re-reads its whole prefix at full
// price. The pool's round-robin walk would hop on every turn, so each surface
// (Claude, OpenAI, Responses) remembers which account last served a
// conversation and asks the pool to pin it there while it stays routable.
//
// Keyed by the deterministic conversationId the translator derives from
// model + system prompt + first user message, so no client cooperation is
// needed. Synthetic anchors produce a random id per request and simply never
// match.
type stickyRouter struct {
	mu             sync.Mutex
	byConversation map[string]stickyEntry
}

type stickyEntry struct {
	accountID string
	expires   time.Time
}

const (
	// stickyTTL is the longest Kiro prefix-cache lifetime the pin is worth
	// keeping; past it the next turn pays full price on any account.
	stickyTTL = time.Hour
	// shortcut: when the map fills, expired entries are dropped and, failing
	// that, the whole map; upgrade to LRU if a deployment ever carries more
	// than this many live conversations at once.
	stickyMaxEntries = 20000
)

func newStickyRouter() *stickyRouter {
	return &stickyRouter{byConversation: make(map[string]stickyEntry)}
}

// Lookup returns the account that last served the conversation, or "" when
// unknown or expired.
func (s *stickyRouter) Lookup(conversationID string) string {
	if s == nil || conversationID == "" {
		return ""
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	e, ok := s.byConversation[conversationID]
	if !ok {
		return ""
	}
	if time.Now().After(e.expires) {
		delete(s.byConversation, conversationID)
		return ""
	}
	return e.accountID
}

// Remember records a successful turn: the next turn of this conversation
// should go to the same account.
func (s *stickyRouter) Remember(conversationID, accountID string) {
	if s == nil || conversationID == "" || accountID == "" {
		return
	}
	now := time.Now()
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(s.byConversation) >= stickyMaxEntries {
		for id, e := range s.byConversation {
			if now.After(e.expires) {
				delete(s.byConversation, id)
			}
		}
		if len(s.byConversation) >= stickyMaxEntries {
			s.byConversation = make(map[string]stickyEntry)
		}
	}
	s.byConversation[conversationID] = stickyEntry{accountID: accountID, expires: now.Add(stickyTTL)}
}
