package app

import (
	"encoding/json"
	"regexp"
)

// Persist only the admitted selection and generation parameters. Transport
// credentials, URLs and arbitrary client config must never enter public history.
type platformModelSnapshot struct {
	Version     int               `json:"version"`
	Model       string            `json:"model"`
	Protocol    string            `json:"protocol"`
	Capability  string            `json:"capability"`
	Parameters  map[string]string `json:"parameters"`
	TextOptions canvasTextOptions `json:"textOptions"`
}

var platformSnapshotValue = regexp.MustCompile(`^[a-zA-Z0-9_.:+-]{0,128}$`)
var platformParameterKeys = map[string][]string{
	"text":  {},
	"image": {"size", "quality", "count", "transparentBackground"},
	"video": {"size", "videoSeconds", "vquality", "videoGenerateAudio", "videoWatermark"},
	"audio": {"audioVoice", "audioFormat", "audioSpeed"},
}

func freezePlatformModelSnapshot(input map[string]any) platformModelSnapshot {
	config, _ := input["config"].(map[string]any)
	snapshot := platformModelSnapshot{Version: 1, Model: stringValue(config["model"]), Protocol: stringValue(config["interfaceType"]), Capability: stringValue(input["mode"]), Parameters: map[string]string{}}
	for _, key := range platformParameterKeys[snapshot.Capability] {
		if value, ok := config[key].(string); ok && platformSnapshotValue.MatchString(value) {
			snapshot.Parameters[key] = value
		}
	}
	if raw, err := json.Marshal(input["textOptions"]); err == nil {
		_ = json.Unmarshal(raw, &snapshot.TextOptions)
	}
	return snapshot
}

func publicPlatformModelSnapshot(value any) *platformModelSnapshot {
	raw, err := json.Marshal(value)
	if err != nil {
		return nil
	}
	var snapshot platformModelSnapshot
	if json.Unmarshal(raw, &snapshot) != nil || snapshot.Version != 1 || snapshot.Model == "" || !platformSnapshotValue.MatchString(snapshot.Model) || !platformSnapshotValue.MatchString(snapshot.Protocol) || normalizeCapability(snapshot.Capability) == "" {
		return nil
	}
	parameters := map[string]string{}
	for _, key := range platformParameterKeys[snapshot.Capability] {
		if value, ok := snapshot.Parameters[key]; ok && platformSnapshotValue.MatchString(value) {
			parameters[key] = value
		}
	}
	snapshot.Parameters = parameters
	return &snapshot
}
