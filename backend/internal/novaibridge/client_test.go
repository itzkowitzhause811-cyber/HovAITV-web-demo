package novaibridge

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"

	"infinite-canvas/backend/internal/app"
)

const testBridgeSecret = "fake-bridge-secret-long-enough-for-tests"
const testUserID = "11111111-1111-4111-8111-111111111111"

func testCatalog(userID, version string) Catalog {
	ref := CredentialPrefix + userID + ":" + version
	return Catalog{CredentialRef: ref, Channels: []Channel{{
		ID: "novai-platform", Name: "NovAI", BaseURL: "/api/ai/system/novai", APIFormat: "openai", Scope: "system",
		Enabled: true, Pinned: true, CredentialRef: ref, HasAPIKey: true, Models: []string{"text-test", "text-alternate", "voice-test"},
		ModelProfiles: []Profile{{Model: "text-test", DisplayName: "测试文本", Capability: "text", Protocol: "chat-completion", CapabilityConfig: map[string]any{"text": map[string]any{"streaming": true}}},
			{Model: "text-alternate", DisplayName: "测试可用文本", Capability: "text", Protocol: "chat-completion", CapabilityConfig: map[string]any{"text": map[string]any{"streaming": true}}},
			{Model: "voice-test", DisplayName: "测试声音", Capability: "audio", Protocol: "openai-audio", DefaultOptions: map[string]any{"voice": "alloy", "response_format": "wav", "speed": 1}}},
	}}}
}

func fakeGateway(t *testing.T, provider http.HandlerFunc) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("X-Novai-Bridge-Secret") != testBridgeSecret {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		switch r.URL.Path {
		case "/api/v1/novtv/internal/models":
			_ = json.NewEncoder(w).Encode(map[string]any{"code": 0, "data": testCatalog(r.Header.Get("X-Novai-User-ID"), r.Header.Get("X-Novai-Credential-Version"))})
		case "/api/v1/novtv/internal/token":
			var input map[string]string
			if json.NewDecoder(r.Body).Decode(&input) != nil || input["credential_ref"] != testCatalog(r.Header.Get("X-Novai-User-ID"), r.Header.Get("X-Novai-Credential-Version")).CredentialRef {
				w.WriteHeader(http.StatusForbidden)
				return
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"code": 0, "data": map[string]any{"base_url": compatPath(input["capability"]), "api_key": "ephemeral-test-token"}})
		default:
			if provider == nil {
				w.WriteHeader(http.StatusNotFound)
				return
			}
			provider(w, r)
		}
	}))
}

func TestAdmissionUsesAccountCatalogAndFreezesNoToken(t *testing.T) {
	gateway := fakeGateway(t, nil)
	defer gateway.Close()
	client, err := NewClient(gateway.URL, testBridgeSecret, testUserID, "v1")
	if err != nil {
		t.Fatal(err)
	}
	config := map[string]any{"credentialRef": testCatalog(testUserID, "v1").CredentialRef, "model": "text-test", "channelId": "attacker-channel", "apiKey": "client-key", "baseUrl": "https://attacker.example", "systemPrompt": "keep this instruction", "size": "1:1"}
	before := cloneForTest(t, config)
	admitted, err := client.AdmitModel(config, "text")
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(config, before) {
		t.Fatal("admission mutated caller config")
	}
	if admitted["apiKey"] != "" || admitted["channelId"] != "" || admitted["systemPrompt"] != "keep this instruction" || admitted["interfaceType"] != "chat-completion" || admitted["baseUrl"] != gateway.URL+compatPath("text") {
		t.Fatalf("incorrect admitted model selection: %#v", admitted)
	}
	for _, invalid := range []map[string]any{
		{"credentialRef": testCatalog(testUserID, "v1").CredentialRef, "model": "not-in-catalog"},
		{"credentialRef": CredentialPrefix + "foreign-user", "model": "text-test"},
		{"credentialRef": "", "model": "text-test", "apiKey": "client-key"},
	} {
		if _, err := client.AdmitModel(invalid, "text"); err == nil {
			t.Fatal("untrusted model selection was accepted")
		}
	}
	if _, err := client.AdmitModel(config, "video"); err == nil {
		t.Fatal("wrong capability was accepted")
	}
	connection, err := client.ResolveModel(context.Background(), app.ExternalModelSelection{CredentialRef: admitted["credentialRef"].(string), Model: "text-test", Protocol: "chat-completion"})
	if err != nil || connection.APIKey != "ephemeral-test-token" || connection.BaseURL != gateway.URL+compatPath("text") {
		t.Fatalf("execution connection unavailable: %v", err)
	}
	if admitted["apiKey"] != "" {
		t.Fatal("execution token entered the snapshot")
	}
	client.SetCredentialVersion("v2")
	if _, err := client.ResolveModel(context.Background(), app.ExternalModelSelection{CredentialRef: admitted["credentialRef"].(string), Model: "text-test", Protocol: "chat-completion"}); err == nil {
		t.Fatal("stale credential version remained executable")
	}
}

func TestConfigKeepsPreferencesWithoutBuiltinModelsOrKeys(t *testing.T) {
	gateway := fakeGateway(t, nil)
	defer gateway.Close()
	client, _ := NewClient(gateway.URL, testBridgeSecret, testUserID, "v1")
	config, err := NewConfig(client, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if err := config.SaveLocalModelConfig([]byte(`{"audioFormat":"wav","systemPrompt":"my original instruction","apiKey":"client-key","channels":[{"id":"injected","apiKey":"client-key","models":["fake-model"]}]}`)); err != nil {
		t.Fatal(err)
	}
	encoded, err := config.ReadLocalModelConfig()
	if err != nil {
		t.Fatal(err)
	}
	for _, forbidden := range []string{"client-key", "fake-model", "hovaiapi", "gpt-5.5"} {
		if strings.Contains(string(encoded), forbidden) {
			t.Fatalf("platform catalog included %q", forbidden)
		}
	}
	var snapshot map[string]any
	_ = json.Unmarshal(encoded, &snapshot)
	if snapshot["systemPrompt"] != "my original instruction" || snapshot["audioFormat"] != "wav" || snapshot["apiKey"] != "" {
		t.Fatal("ordinary original preferences were not retained")
	}
	admitted, err := client.AdmitModel(map[string]any{"credentialRef": testCatalog(testUserID, "v1").CredentialRef, "model": "voice-test"}, "audio")
	if err != nil || admitted["audioFormat"] != "wav" || admitted["audioSpeed"] != "1" || admitted["audioVoice"] != "alloy" {
		t.Fatalf("audio defaults do not match the real model: %v %#v", err, admitted)
	}
	for field, value := range map[string]string{"audioSpeed": "1.5", "audioFormat": "mp3", "audioVoice": "invented-speaker", "audioInstructions": "whisper", "audioPitch": "2", "audioVolume": "2"} {
		config := map[string]any{"credentialRef": testCatalog(testUserID, "v1").CredentialRef, "model": "voice-test", field: value}
		if _, err := client.AdmitModel(config, "audio"); err == nil {
			t.Fatalf("unsupported speech parameter accepted: %s", field)
		}
	}
}

func cloneForTest(t *testing.T, value map[string]any) map[string]any {
	t.Helper()
	encoded, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	var cloned map[string]any
	if err := json.Unmarshal(encoded, &cloned); err != nil {
		t.Fatal(err)
	}
	return cloned
}
