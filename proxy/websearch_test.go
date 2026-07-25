package proxy

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestHasWebSearchTool_SingleNativeTool(t *testing.T) {
	req := &ClaudeRequest{
		Model: "claude-sonnet-4",
		Tools: []ClaudeTool{
			{Type: "web_search_20250305", Name: "web_search"},
		},
	}
	if !hasWebSearchTool(req) {
		t.Fatal("expected single native web_search tool to be detected")
	}
	if hasWebSearchAmongTools(req) {
		t.Fatal("single native tool must not be treated as mixed")
	}
}

func TestHasWebSearchTool_MultipleTools(t *testing.T) {
	req := &ClaudeRequest{
		Model: "claude-sonnet-4",
		Tools: []ClaudeTool{
			{Type: "web_search_20250305", Name: "web_search"},
			{Name: "other_tool", Description: "Other"},
		},
	}
	if hasWebSearchTool(req) {
		t.Fatal("multiple tools must not be treated as pure web_search request")
	}
	if !hasWebSearchAmongTools(req) {
		t.Fatal("expected mixed tools with native web_search")
	}
}

func TestHasWebSearchTool_RegularToolNamedWebSearch(t *testing.T) {
	// Client-defined tools named web_search without type web_search_* must not
	// take the native path.
	req := &ClaudeRequest{
		Model: "claude-sonnet-4",
		Tools: []ClaudeTool{
			{Name: "web_search", Description: "Regular client-side search tool"},
		},
	}
	if hasWebSearchTool(req) {
		t.Fatal("regular tool named web_search must not trigger native websearch")
	}
	if isNativeWebSearchTool(req.Tools[0]) {
		t.Fatal("regular tool must not be native")
	}
}

func TestHasWebSearchTool_NoTools(t *testing.T) {
	req := &ClaudeRequest{Model: "claude-sonnet-4"}
	if hasWebSearchTool(req) {
		t.Fatal("request without tools must not be treated as web_search request")
	}
	if hasWebSearchAmongTools(req) {
		t.Fatal("request without tools must not be mixed web_search")
	}
}

func TestExtractSearchQuery_StringContentWithPrefix(t *testing.T) {
	req := &ClaudeRequest{
		Messages: []ClaudeMessage{
			{Role: "user", Content: "Perform a web search for the query: rust latest version 2026"},
		},
	}
	got := extractSearchQuery(req)
	want := "rust latest version 2026"
	if got != want {
		t.Fatalf("query = %q, want %q", got, want)
	}
}

func TestExtractSearchQuery_StringContentWithoutPrefix(t *testing.T) {
	req := &ClaudeRequest{
		Messages: []ClaudeMessage{
			{Role: "user", Content: "typescript 5.7 features"},
		},
	}
	if got := extractSearchQuery(req); got != "typescript 5.7 features" {
		t.Fatalf("query = %q", got)
	}
}

func TestExtractSearchQuery_LastUserTurn(t *testing.T) {
	req := &ClaudeRequest{
		Messages: []ClaudeMessage{
			{Role: "user", Content: "Perform a web search for the query: first"},
			{Role: "assistant", Content: "ok"},
			{Role: "user", Content: "Perform a web search for the query: second"},
		},
	}
	if got := extractSearchQuery(req); got != "second" {
		t.Fatalf("query = %q, want second", got)
	}
}

func TestExtractSearchQuery_ArrayContent(t *testing.T) {
	// JSON decode yields []interface{} for content arrays.
	raw := `{
		"model": "claude-sonnet-4",
		"messages": [
			{"role": "user", "content": [
				{"type": "text", "text": "Perform a web search for the query: golang generics"}
			]}
		]
	}`
	var req ClaudeRequest
	if err := json.Unmarshal([]byte(raw), &req); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if got := extractSearchQuery(&req); got != "golang generics" {
		t.Fatalf("query = %q", got)
	}
}

func TestExtractSearchQuery_Empty(t *testing.T) {
	req := &ClaudeRequest{}
	if got := extractSearchQuery(req); got != "" {
		t.Fatalf("expected empty query, got %q", got)
	}
}

func TestCreateMcpRequest_Format(t *testing.T) {
	toolUseID, mcpReq := createMcpRequest("hello")

	if !strings.HasPrefix(toolUseID, "srvtoolu_") {
		t.Errorf("toolUseID prefix wrong: %q", toolUseID)
	}
	if len(toolUseID) != len("srvtoolu_")+32 {
		t.Errorf("toolUseID length = %d", len(toolUseID))
	}
	if !strings.HasPrefix(mcpReq.ID, "web_search_tooluse_") {
		t.Errorf("mcp request ID prefix wrong: %q", mcpReq.ID)
	}
	if mcpReq.JSONRPC != "2.0" {
		t.Errorf("jsonrpc = %q", mcpReq.JSONRPC)
	}
	if mcpReq.Method != "tools/call" {
		t.Errorf("method = %q", mcpReq.Method)
	}
	if mcpReq.Params.Name != "web_search" {
		t.Errorf("params.name = %q", mcpReq.Params.Name)
	}
	if mcpReq.Params.Arguments.Query != "hello" {
		t.Errorf("query = %q", mcpReq.Params.Arguments.Query)
	}
}

func TestParseSearchResults(t *testing.T) {
	inner := `{"results":[{"title":"T1","url":"https://e.com","snippet":"s1","publishedDate":1732299319000,"id":"1","domain":"e.com"}],"totalResults":1,"query":"q"}`
	mcpResp := &McpResponse{
		Result: &McpResult{
			Content: []McpContent{{Type: "text", Text: inner}},
		},
	}
	results := parseSearchResults(mcpResp)
	if results == nil {
		t.Fatal("expected results")
	}
	if len(results.Results) != 1 {
		t.Fatalf("results len = %d", len(results.Results))
	}
	r := results.Results[0]
	if r.Title != "T1" || r.URL != "https://e.com" {
		t.Errorf("unexpected result: %+v", r)
	}
	if r.Snippet == nil || *r.Snippet != "s1" {
		t.Errorf("snippet mismatch: %+v", r.Snippet)
	}
}

func TestParseSearchResults_EmbeddedError(t *testing.T) {
	inner := `{"results":[],"error":"upstream failed"}`
	mcpResp := &McpResponse{
		Result: &McpResult{
			Content: []McpContent{{Type: "text", Text: inner}},
		},
	}
	if parseSearchResults(mcpResp) != nil {
		t.Fatal("embedded error must yield nil")
	}
}

func TestParseSearchResults_IsErrorFlag(t *testing.T) {
	mcpResp := &McpResponse{
		Result: &McpResult{
			IsError: true,
			Content: []McpContent{{Type: "text", Text: `{"results":[]}`}},
		},
	}
	if parseSearchResults(mcpResp) != nil {
		t.Fatal("isError must yield nil")
	}
}

func TestParseSearchResults_NonTextContent(t *testing.T) {
	mcpResp := &McpResponse{
		Result: &McpResult{Content: []McpContent{{Type: "image", Text: ""}}},
	}
	if parseSearchResults(mcpResp) != nil {
		t.Fatal("non-text content must yield nil")
	}
}

func TestParseSearchResults_NilResult(t *testing.T) {
	if parseSearchResults(&McpResponse{}) != nil {
		t.Fatal("nil result must yield nil")
	}
}

func TestGenerateSearchSummary_WithResults(t *testing.T) {
	s1 := "a snippet"
	results := &WebSearchResults{
		Results: []WebSearchResult{
			{Title: "Title One", URL: "https://one.com", Snippet: &s1},
		},
	}
	summary := generateSearchSummary("myquery", results)
	for _, want := range []string{"myquery", "Title One", "https://one.com", "a snippet"} {
		if !strings.Contains(summary, want) {
			t.Errorf("summary missing %q:\n%s", want, summary)
		}
	}
}

func TestGenerateSearchSummary_NoResults(t *testing.T) {
	summary := generateSearchSummary("q", nil)
	if !strings.Contains(summary, "No results found") {
		t.Errorf("expected 'No results found':\n%s", summary)
	}
}

func TestGenerateSearchSummary_LongSnippetTruncated(t *testing.T) {
	long := strings.Repeat("x", 300)
	results := &WebSearchResults{
		Results: []WebSearchResult{{Title: "T", URL: "https://e.com", Snippet: &long}},
	}
	summary := generateSearchSummary("q", results)
	if !strings.Contains(summary, "...") {
		t.Error("expected long snippet to be truncated with ellipsis")
	}
}

func TestChunkByRunes(t *testing.T) {
	chunks := chunkByRunes("abcdef", 2)
	if len(chunks) != 3 {
		t.Fatalf("chunks = %v", chunks)
	}
	if strings.Join(chunks, "") != "abcdef" {
		t.Errorf("rejoined = %q", strings.Join(chunks, ""))
	}
}

func TestChunkByRunes_Multibyte(t *testing.T) {
	in := "あいうえおかきくけこ"
	chunks := chunkByRunes(in, 3)
	if strings.Join(chunks, "") != in {
		t.Errorf("multibyte rejoin failed: %q", strings.Join(chunks, ""))
	}
	for _, c := range chunks {
		if !json.Valid([]byte(`"` + c + `"`)) {
			t.Errorf("chunk not valid utf-8: %q", c)
		}
	}
}

func TestShouldSearchRound(t *testing.T) {
	web := []KiroToolUse{{Name: "web_search"}, {Name: "web_search"}}
	if !shouldSearchRound(0, web) {
		t.Fatal("pure web_search should continue")
	}
	if shouldSearchRound(maxWebSearchRounds, web) {
		t.Fatal("at limit should stop")
	}
	mixed := []KiroToolUse{{Name: "web_search"}, {Name: "Bash"}}
	if shouldSearchRound(0, mixed) {
		t.Fatal("mixed tools should not continue loop")
	}
	if shouldSearchRound(0, nil) {
		t.Fatal("empty tool uses should not continue")
	}
}

func TestResolveFlushStopReason(t *testing.T) {
	if got := resolveFlushStopReason("max_tokens", nil, nil); got != "max_tokens" {
		t.Fatalf("override: %q", got)
	}
	client := []KiroToolUse{{Name: "Bash"}}
	if got := resolveFlushStopReason("", client, nil); got != "tool_use" {
		t.Fatalf("client tool: %q", got)
	}
	webOnly := []KiroToolUse{{Name: "web_search"}}
	if got := resolveFlushStopReason("", webOnly, nil); got != "end_turn" {
		t.Fatalf("web only: %q", got)
	}
	contentWithClient := []map[string]interface{}{
		{"type": "tool_use", "name": "Bash"},
	}
	if got := resolveFlushStopReason("", nil, contentWithClient); got != "tool_use" {
		t.Fatalf("content client tool: %q", got)
	}
}

func TestBuildFlushContent_WebSearchAsServerTool(t *testing.T) {
	snippet := "hello"
	results := &WebSearchResults{
		Results: []WebSearchResult{{Title: "T", URL: "https://e.com", Snippet: &snippet}},
	}
	content := buildFlushContent(nil, "done", []KiroToolUse{
		{ToolUseID: "toolu_1", Name: "web_search", Input: map[string]interface{}{"query": "q"}},
		{ToolUseID: "toolu_2", Name: "Bash", Input: map[string]interface{}{"command": "ls"}},
	}, []*WebSearchResults{results, nil})

	var sawServer, sawClient, sawRawWeb bool
	for _, b := range content {
		switch b["type"] {
		case "server_tool_use":
			sawServer = true
			if b["name"] != "web_search" {
				t.Errorf("server tool name = %v", b["name"])
			}
		case "web_search_tool_result":
			// ok
		case "tool_use":
			if b["name"] == "web_search" {
				sawRawWeb = true
			}
			if b["name"] == "Bash" {
				sawClient = true
			}
		}
	}
	if !sawServer {
		t.Error("expected server_tool_use for web_search")
	}
	if !sawClient {
		t.Error("expected raw tool_use for Bash")
	}
	if sawRawWeb {
		t.Error("web_search must not be flushed as raw tool_use")
	}
}

func TestConvertClaudeTools_SkipsNativeWebSearchAndInjectsSchema(t *testing.T) {
	tools := []ClaudeTool{
		{Type: "web_search_20250305", Name: "web_search"},
		{Name: "Bash", Description: "run", InputSchema: map[string]interface{}{"type": "object"}},
	}
	kiroTools, nameMap := convertClaudeTools(tools)
	var sawWeb, sawClient bool
	for _, tspec := range kiroTools {
		name := tspec.ToolSpecification.Name
		switch {
		case name == "web_search":
			sawWeb = true
			schema, ok := tspec.ToolSpecification.InputSchema.JSON.(map[string]interface{})
			if !ok {
				t.Fatal("web_search schema must be object map")
			}
			props, _ := schema["properties"].(map[string]interface{})
			if props == nil || props["query"] == nil {
				t.Fatalf("web_search schema missing query: %+v", schema)
			}
		case name == "Bash" || name == "bash" || nameMap[name] == "Bash":
			sawClient = true
		}
	}
	if !sawWeb {
		t.Error("expected injected web_search schema for mixed tools")
	}
	if !sawClient {
		t.Errorf("expected client Bash tool in %+v (nameMap=%v)", kiroTools, nameMap)
	}
}

func TestConvertClaudeTools_PureNativeWebSearchSkipped(t *testing.T) {
	// Pure path never calls convertClaudeTools. If it did, native-only must not
	// inject a Kiro web_search (no client tools remain after filtering).
	tools := []ClaudeTool{
		{Type: "web_search_20250305", Name: "web_search"},
	}
	kiroTools, _ := convertClaudeTools(tools)
	if len(kiroTools) != 0 {
		t.Fatalf("pure native web_search must not produce Kiro tools, got %+v", kiroTools)
	}
}

func TestClaudeToolTypeJSONRoundTrip(t *testing.T) {
	raw := `{"type":"web_search_20250305","name":"web_search","max_uses":8}`
	var tool ClaudeTool
	if err := json.Unmarshal([]byte(raw), &tool); err != nil {
		t.Fatal(err)
	}
	if tool.Type != "web_search_20250305" || tool.Name != "web_search" || tool.MaxUses != 8 {
		t.Fatalf("tool = %+v", tool)
	}
	if !isNativeWebSearchTool(tool) {
		t.Fatal("expected native")
	}
}

func TestBuildWebSearchContentBlocks(t *testing.T) {
	s := "snip"
	results := &WebSearchResults{
		Results: []WebSearchResult{{Title: "T", URL: "https://e.com", Snippet: &s}},
	}
	blocks := buildWebSearchContentBlocks("q", "srvtoolu_abc", results)
	if len(blocks) != 4 {
		t.Fatalf("blocks len = %d", len(blocks))
	}
	if blocks[1]["type"] != "server_tool_use" {
		t.Errorf("block1 type = %v", blocks[1]["type"])
	}
	if blocks[2]["type"] != "web_search_tool_result" {
		t.Errorf("block2 type = %v", blocks[2]["type"])
	}
}
