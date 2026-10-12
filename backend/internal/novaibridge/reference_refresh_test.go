package novaibridge

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"infinite-canvas/backend/internal/app"
)

func TestDirectoryRefreshAndProcessRestartKeepSameAccountSnapshotExecutable(t *testing.T) {
	var refresh atomic.Int32
	gateway := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("X-Novai-Bridge-Secret") != testBridgeSecret {
			w.WriteHeader(401)
			return
		}
		catalog := testCatalog(r.Header.Get("X-Novai-User-ID"), r.Header.Get("X-Novai-Credential-Version"))
		if r.URL.Path == "/api/v1/novtv/internal/models" {
			catalog.CredentialRef += fmt.Sprintf(":refresh-%d", refresh.Add(1))
			catalog.Channels[0].CredentialRef = catalog.CredentialRef
			json.NewEncoder(w).Encode(map[string]any{"code": 0, "data": catalog})
			return
		}
		var input map[string]string
		if json.NewDecoder(r.Body).Decode(&input) != nil || !strings.HasPrefix(input["credential_ref"], catalog.CredentialRef+":refresh-") {
			w.WriteHeader(403)
			return
		}
		json.NewEncoder(w).Encode(map[string]any{"code": 0, "data": map[string]any{"base_url": compatPath("text"), "api_key": "ephemeral-test-token"}})
	}))
	defer gateway.Close()
	client, _ := NewClient(gateway.URL, testBridgeSecret, testUserID, "v1")
	catalog, err := client.Catalog(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	input := map[string]any{"credentialRef": catalog.CredentialRef, "model": "text-test"}
	admitted, err := client.AdmitModel(input, "text")
	if err != nil {
		t.Fatal("directory refresh rejected a valid same-account reference", err)
	}
	selection := app.ExternalModelSelection{CredentialRef: admitted["credentialRef"].(string), Model: "text-test", Protocol: "chat-completion"}
	restarted, _ := NewClient(gateway.URL, testBridgeSecret, testUserID, "v1")
	if _, err := restarted.ResolveModel(context.Background(), selection); err != nil {
		t.Fatal("snapshot could not recover after a bridge restart", err)
	}
	other, _ := NewClient(gateway.URL, testBridgeSecret, secondTestUserID, "v1")
	if _, err := other.AdmitModel(input, "text"); err == nil {
		t.Fatal("another account could persist the snapshot reference")
	}
	client.SetCredentialVersion("v2")
	if _, err := client.ResolveModel(context.Background(), selection); err == nil {
		t.Fatal("revoked version remained executable")
	}
}
