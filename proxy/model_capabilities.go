package proxy

import (
	"strings"
	"sync"
)

// Model reasoning capabilities, derived entirely from the upstream
// ListAvailableModels response.
//
// Kiro advertises per-model `additionalModelRequestFieldsSchema` objects that
// describe exactly which reasoning directive a model accepts, which effort
// levels are legal, and what the upstream default is. Two shapes exist today:
//
//	Claude families                      GPT families
//	------------------------------------ ------------------------------------
//	properties.thinking.type             properties.reasoning.effort
//	  enum: [adaptive, disabled]           enum: [none, low, medium, high, xhigh, max]
//	properties.thinking.display          properties.reasoning.mode
//	  enum: [summarized, omitted]          enum: [standard, pro]
//	properties.output_config.effort
//	  enum: [low, medium, high, (xhigh), max]
//
// The enum is not uniform across models — some Claude families omit "xhigh",
// some default to "xhigh" instead of "high", and only the GPT schema accepts
// "none". Because `additionalProperties` is false upstream, sending a directive
// a model does not advertise (or an effort outside its enum) is a hard upstream
// 400 — so this registry is the authority, and models with no schema at all get
// no reasoning directive.
//
// Nothing here is hardcoded per model: new models and changed enums are picked
// up on the next model-cache refresh.

// reasoningTransport identifies how a model receives its reasoning directive.
type reasoningTransport int

const (
	// reasoningTransportNone means the model advertises no reasoning directive.
	reasoningTransportNone reasoningTransport = iota
	// reasoningTransportThinking is the Claude pair: root-level `thinking`
	// (type/display) plus `output_config.effort`.
	reasoningTransportThinking
	// reasoningTransportAdditionalFields is the GPT form:
	// additionalModelRequestFields.reasoning.effort.
	reasoningTransportAdditionalFields
)

// effortLadder is the ordering used to clamp a requested effort onto whatever a
// model actually advertises. "none" is deliberately absent: it means "no
// reasoning" rather than a rung on the ladder.
var effortLadder = []string{"low", "medium", "high", "xhigh", "max"}

// modelReasoningCapability is the resolved, upstream-advertised reasoning
// contract for one model.
type modelReasoningCapability struct {
	Transport reasoningTransport
	// Efforts is the advertised effort enum, ladder-ordered, excluding "none".
	Efforts []string
	// DefaultEffort is the schema's documented default, or "" when absent.
	DefaultEffort string
	// SupportsNone reports whether the enum contains "none", i.e. whether the
	// model accepts an explicit "no reasoning" value (GPT families do).
	SupportsNone bool
	// Displays is the advertised thinking.display enum (Claude only).
	Displays []string
}

// SupportsEffort reports whether the model advertises the given effort level.
func (c modelReasoningCapability) SupportsEffort(effort string) bool {
	for _, e := range c.Efforts {
		if e == effort {
			return true
		}
	}
	return false
}

// SupportsDisplay reports whether the model advertises the given
// thinking.display value.
func (c modelReasoningCapability) SupportsDisplay(display string) bool {
	for _, d := range c.Displays {
		if d == display {
			return true
		}
	}
	return false
}

// ModelRequestFieldsSchema is the subset of the upstream JSON-Schema blob we
// interpret. Unknown properties are ignored.
type ModelRequestFieldsSchema struct {
	Properties struct {
		Thinking *struct {
			Properties struct {
				Type    *schemaStringField `json:"type"`
				Display *schemaStringField `json:"display"`
			} `json:"properties"`
		} `json:"thinking"`
		OutputConfig *struct {
			Properties struct {
				Effort *schemaStringField `json:"effort"`
			} `json:"properties"`
		} `json:"output_config"`
		Reasoning *struct {
			Properties struct {
				Effort *schemaStringField `json:"effort"`
				Mode   *schemaStringField `json:"mode"`
			} `json:"properties"`
		} `json:"reasoning"`
	} `json:"properties"`
}

// schemaStringField is a JSON-Schema string property with an optional enum and
// default.
type schemaStringField struct {
	Enum    []string `json:"enum"`
	Default string   `json:"default"`
}

func (f *schemaStringField) values() []string {
	if f == nil {
		return nil
	}
	out := make([]string, 0, len(f.Enum))
	for _, v := range f.Enum {
		if v := strings.ToLower(strings.TrimSpace(v)); v != "" {
			out = append(out, v)
		}
	}
	return out
}

func (f *schemaStringField) defaultValue() string {
	if f == nil {
		return ""
	}
	return strings.ToLower(strings.TrimSpace(f.Default))
}

// sortEffortsByLadder returns the advertised efforts in ladder order and reports
// whether "none" was advertised. Values outside the known ladder are appended
// verbatim so a future rung is still usable (it just cannot be clamped to).
func sortEffortsByLadder(values []string) (efforts []string, supportsNone bool) {
	seen := make(map[string]bool, len(values))
	for _, v := range values {
		if v == "none" {
			supportsNone = true
			continue
		}
		seen[v] = true
	}
	for _, rung := range effortLadder {
		if seen[rung] {
			efforts = append(efforts, rung)
			delete(seen, rung)
		}
	}
	for _, v := range values {
		if seen[v] {
			efforts = append(efforts, v)
			delete(seen, v)
		}
	}
	return efforts, supportsNone
}

// reasoningCapabilityFromSchema interprets one model's advertised schema. The
// zero capability (transport none) is returned when the model advertises no
// reasoning directive.
func reasoningCapabilityFromSchema(schema *ModelRequestFieldsSchema) modelReasoningCapability {
	if schema == nil {
		return modelReasoningCapability{}
	}

	// GPT form: additionalModelRequestFields.reasoning.effort.
	if r := schema.Properties.Reasoning; r != nil {
		efforts, supportsNone := sortEffortsByLadder(r.Properties.Effort.values())
		if len(efforts) > 0 || supportsNone {
			return modelReasoningCapability{
				Transport:     reasoningTransportAdditionalFields,
				Efforts:       efforts,
				DefaultEffort: r.Properties.Effort.defaultValue(),
				SupportsNone:  supportsNone,
			}
		}
	}

	// Claude form: thinking + output_config.effort. The thinking block is what
	// switches reasoning on, so it is required; output_config only carries the
	// effort enum.
	if th := schema.Properties.Thinking; th != nil {
		var efforts []string
		var supportsNone bool
		defaultEffort := ""
		if oc := schema.Properties.OutputConfig; oc != nil {
			efforts, supportsNone = sortEffortsByLadder(oc.Properties.Effort.values())
			defaultEffort = oc.Properties.Effort.defaultValue()
		}
		adaptive := false
		for _, t := range th.Properties.Type.values() {
			if t == "adaptive" {
				adaptive = true
				break
			}
		}
		if !adaptive {
			return modelReasoningCapability{}
		}
		return modelReasoningCapability{
			Transport:     reasoningTransportThinking,
			Efforts:       efforts,
			DefaultEffort: defaultEffort,
			SupportsNone:  supportsNone,
			Displays:      th.Properties.Display.values(),
		}
	}

	return modelReasoningCapability{}
}

// modelCapabilityRegistry caches the reasoning contract for every model seen in
// an upstream ListAvailableModels response, keyed by lowercased model id.
var (
	modelCapabilityMu       sync.RWMutex
	modelCapabilityRegistry = map[string]modelReasoningCapability{}
)

// updateModelReasoningCapabilities records (or replaces) the reasoning contract
// for each model in an upstream response. Entries are merged rather than
// swapped wholesale because different accounts may see different model subsets.
func updateModelReasoningCapabilities(models []ModelInfo) {
	if len(models) == 0 {
		return
	}
	modelCapabilityMu.Lock()
	defer modelCapabilityMu.Unlock()
	for _, m := range models {
		key := strings.ToLower(strings.TrimSpace(m.ModelId))
		if key == "" {
			continue
		}
		// A refresh that reports no schema for a model we already know is a
		// narrower account view, not a capability loss: keep what we have.
		cap := reasoningCapabilityFromSchema(m.AdditionalModelRequestFieldsSchema)
		if cap.Transport == reasoningTransportNone {
			if existing, ok := modelCapabilityRegistry[key]; ok && existing.Transport != reasoningTransportNone {
				continue
			}
		}
		modelCapabilityRegistry[key] = cap
	}
}

// lookupModelReasoningCapability returns the upstream-advertised reasoning
// contract for a resolved model id. ok is false when the upstream model list has
// not been seen yet (or does not contain this model), which callers must treat
// as "attach no directive" rather than guessing.
func lookupModelReasoningCapability(modelID string) (modelReasoningCapability, bool) {
	candidates := modelLookupCandidates(modelID)
	if len(candidates) == 0 {
		return modelReasoningCapability{}, false
	}
	modelCapabilityMu.RLock()
	defer modelCapabilityMu.RUnlock()
	// Try the name as asked for, then its alias target: the registry is keyed by
	// the real upstream ids, which is also what the payload is sent with.
	for _, key := range candidates {
		if cap, ok := modelCapabilityRegistry[key]; ok {
			return cap, true
		}
	}
	return modelReasoningCapability{}, false
}

// modelLookupCandidates returns the lowercased keys to try when looking a model
// up in upstream-derived data: the name as asked for, then its alias target. The
// second form matters because a client may ask for a name the proxy redirects
// (e.g. a dated snapshot, or a name carrying the thinking suffix) while the
// upstream list only knows the target.
func modelLookupCandidates(model string) []string {
	key := strings.ToLower(strings.TrimSpace(model))
	if key == "" {
		return nil
	}
	mapped := strings.ToLower(strings.TrimSpace(MapModel(model)))
	if mapped == "" || mapped == key {
		return []string{key}
	}
	return []string{key, mapped}
}

// resetModelReasoningCapabilities clears the registry. Test-only helper.
func resetModelReasoningCapabilities() {
	modelCapabilityMu.Lock()
	defer modelCapabilityMu.Unlock()
	modelCapabilityRegistry = map[string]modelReasoningCapability{}
}
