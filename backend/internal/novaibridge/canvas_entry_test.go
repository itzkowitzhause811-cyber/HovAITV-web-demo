package novaibridge

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"
)

func TestPlatformProjectEntryPreservesExistingCanvasAndIsolatesAccounts(t *testing.T) {
	gateway := fakeGateway(t, nil)
	defer gateway.Close()
	server, err := NewServer(ServerOptions{DataDir: t.TempDir(), GatewayURL: gateway.URL, BridgeSecret: testBridgeSecret})
	if err != nil {
		t.Fatal(err)
	}
	defer server.Close(context.Background())
	id := "33333333-3333-4333-8333-333333333333"
	entry := map[string]string{"id": id, "title": "原平台项目"}
	if result := platformRequest(t, server, testUserID, http.MethodPost, "/api/platform/canvas-entry", entry); result.Code != http.StatusOK {
		t.Fatalf("entry: %s", result.Body.String())
	}
	var data struct {
		Project map[string]any `json:"project"`
	}
	decodeData(t, platformRequest(t, server, testUserID, http.MethodGet, "/api/canvas-projects/"+id, nil), &data)
	if data.Project["title"] != entry["title"] || data.Project["workspaceProjectId"] != id {
		t.Fatal("original project was not linked")
	}
	data.Project["nodes"] = []any{map[string]any{"id": "text-node", "type": "text", "x": 0, "y": 0, "width": 320, "height": 180, "data": map[string]any{"text": "kept result"}}}
	if result := platformRequest(t, server, testUserID, http.MethodPut, "/api/canvas-projects/"+id, map[string]any{"project": data.Project}); result.Code != http.StatusOK {
		t.Fatalf("save: %s", result.Body.String())
	}
	entry["title"] = "changed incoming title"
	if result := platformRequest(t, server, testUserID, http.MethodPost, "/api/platform/canvas-entry", entry); result.Code != http.StatusOK {
		t.Fatal(result.Body.String())
	}
	decodeData(t, platformRequest(t, server, testUserID, http.MethodGet, "/api/canvas-projects/"+id, nil), &data)
	if len(data.Project["nodes"].([]any)) != 1 || data.Project["title"] != "原平台项目" {
		t.Fatal("repeat admission overwrote persisted work")
	}
	if result := platformRequest(t, server, secondTestUserID, http.MethodGet, "/api/canvas-projects/"+id, nil); result.Code == http.StatusOK {
		t.Fatal("another account read project canvas")
	}
	raw, _ := json.Marshal(data.Project)
	if len(raw) == 0 {
		t.Fatal("missing persisted canvas")
	}
}
