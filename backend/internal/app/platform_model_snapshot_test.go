package app

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestPlatformModelSnapshotSurvivesCompactionWithoutTransportSecrets(t *testing.T) {
	config := map[string]any{"model": "video-1", "interfaceType": "volcengine-ark-video", "videoSeconds": "4", "vquality": "720p", "size": "16:9", "apiKey": "secret-key", "baseUrl": "https://private.example"}
	input := map[string]any{"mode": "video", "config": config, "textOptions": map[string]any{"stream": true}}
	input["platformModelSnapshot"] = freezePlatformModelSnapshot(input)
	config["model"] = "video-2"
	config["videoSeconds"] = "8"
	raw, _ := json.Marshal(input)
	compacted := publicTaskInputJSON(string(raw))
	if !strings.Contains(compacted, `"model":"video-1"`) || !strings.Contains(compacted, `"videoSeconds":"4"`) || strings.Contains(compacted, "video-2") || strings.Contains(compacted, "secret-key") || strings.Contains(compacted, "private.example") {
		t.Fatal(compacted)
	}
	if publicTaskInputJSON(compacted) != compacted {
		t.Fatal("repeat compaction changed immutable history")
	}
	var injected map[string]any
	_ = json.Unmarshal([]byte(`{"version":1,"model":"video-1","protocol":"video","capability":"video","apiKey":"secret-key","parameters":{"apiKey":"secret-key","size":"https://private.example","videoSeconds":"4"}}`), &injected)
	clean, _ := json.Marshal(publicPlatformModelSnapshot(injected))
	if strings.Contains(string(clean), "secret-key") || strings.Contains(string(clean), "private.example") {
		t.Fatal(string(clean))
	}
}
