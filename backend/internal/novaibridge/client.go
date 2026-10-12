package novaibridge

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"infinite-canvas/backend/internal/app"
)

const CredentialPrefix = "novai-hovaitv:"

var errAuthorization = errors.New("platform model authorization unavailable")

type Profile struct {
	Model            string         `json:"model"`
	DisplayName      string         `json:"displayName"`
	Capability       string         `json:"capability"`
	Protocol         string         `json:"protocol"`
	CapabilityConfig map[string]any `json:"capabilityConfig"`
	DefaultOptions   map[string]any `json:"defaultOptions"`
}

type Channel struct {
	ID            string         `json:"id"`
	Name          string         `json:"name"`
	BaseURL       string         `json:"baseUrl"`
	APIKey        string         `json:"apiKey"`
	APIFormat     string         `json:"apiFormat"`
	Scope         string         `json:"scope"`
	Enabled       bool           `json:"enabled"`
	Pinned        bool           `json:"pinned"`
	CredentialRef string         `json:"credentialRef"`
	HasAPIKey     bool           `json:"hasApiKey"`
	Models        []string       `json:"models"`
	ModelProfiles []Profile      `json:"modelProfiles"`
	Limits        map[string]any `json:"limits,omitempty"`
}

type Catalog struct {
	CredentialRef string    `json:"credential_ref"`
	Channels      []Channel `json:"channels"`
	AudioFormat   string    `json:"audioFormat"`
	AudioVoice    string    `json:"audioVoice"`
	AudioSpeed    string    `json:"audioSpeed"`
}

type Client struct {
	baseURL string
	secret  string
	userID  string
	mu      sync.RWMutex
	version string
	http    *http.Client
}

func NewClient(baseURL, secret, userID, version string) (*Client, error) {
	endpoint, err := url.Parse(strings.TrimRight(baseURL, "/"))
	if err != nil || endpoint.Host == "" || (endpoint.Scheme != "http" && endpoint.Scheme != "https") || endpoint.User != nil || endpoint.RawQuery != "" || endpoint.Fragment != "" || endpoint.Path != "" {
		return nil, errors.New("invalid NovAI gateway origin")
	}
	if len(secret) < 32 || userID == "" || strings.TrimSpace(version) == "" {
		return nil, errors.New("NovAI bridge identity is incomplete")
	}
	return &Client{baseURL: endpoint.String(), secret: secret, userID: userID, version: version,
		http: &http.Client{Timeout: 15 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}}, nil
}

func (c *Client) SetCredentialVersion(version string) {
	c.mu.Lock()
	c.version = version
	c.mu.Unlock()
}

func (c *Client) request(ctx context.Context, method, path string, body any, target any) error {
	var reader io.Reader
	if body != nil {
		encoded, err := json.Marshal(body)
		if err != nil {
			return errAuthorization
		}
		reader = bytes.NewReader(encoded)
	}
	req, err := http.NewRequestWithContext(ctx, method, c.baseURL+path, reader)
	if err != nil {
		return errAuthorization
	}
	c.mu.RLock()
	version := c.version
	c.mu.RUnlock()
	req.Header.Set("X-Novai-Bridge-Secret", c.secret)
	req.Header.Set("X-Novai-User-ID", c.userID)
	req.Header.Set("X-Novai-Credential-Version", version)
	req.Header.Set("Content-Type", "application/json")
	response, err := c.http.Do(req)
	if err != nil {
		return errAuthorization
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return errAuthorization
	}
	var envelope struct {
		Code int             `json:"code"`
		Data json.RawMessage `json:"data"`
	}
	if err := json.NewDecoder(io.LimitReader(response.Body, 2<<20)).Decode(&envelope); err != nil || envelope.Code != 0 || len(envelope.Data) == 0 {
		return errAuthorization
	}
	if json.Unmarshal(envelope.Data, target) != nil {
		return errAuthorization
	}
	return nil
}

func (c *Client) Catalog(ctx context.Context) (Catalog, error) {
	var catalog Catalog
	if err := c.request(ctx, http.MethodGet, "/api/v1/novtv/internal/models", nil, &catalog); err != nil {
		return catalog, err
	}
	if !strings.HasPrefix(catalog.CredentialRef, CredentialPrefix) || len(catalog.CredentialRef) <= len(CredentialPrefix) {
		return Catalog{}, errAuthorization
	}
	for index := range catalog.Channels {
		channel := &catalog.Channels[index]
		if channel.CredentialRef != catalog.CredentialRef || channel.APIKey != "" {
			return Catalog{}, errAuthorization
		}
		channel.APIKey = ""
	}
	return catalog, nil
}

func findProfile(catalog Catalog, ref, model, capability, protocol string) (Profile, bool) {
	// Directory refreshes rotate the opaque AEAD reference. Its account and
	// credential version are verified by the gateway token endpoint, while this
	// lookup verifies the currently allowed model/protocol.
	if !strings.HasPrefix(ref, CredentialPrefix) || len(ref) <= len(CredentialPrefix) {
		return Profile{}, false
	}
	for _, channel := range catalog.Channels {
		if !channel.Enabled || channel.CredentialRef != catalog.CredentialRef {
			continue
		}
		listed := false
		for _, name := range channel.Models {
			listed = listed || name == model
		}
		if !listed {
			continue
		}
		for _, profile := range channel.ModelProfiles {
			if profile.Model == model && (capability == "" || profile.Capability == capability) && (protocol == "" || profile.Protocol == protocol) {
				return profile, true
			}
		}
	}
	return Profile{}, false
}

func compatPath(capability string) string {
	switch capability {
	case "text":
		return "/api/v1/novtv/internal/compat/llm/v1"
	case "image":
		return "/api/v1/novtv/internal/compat/image/api/v3"
	case "video":
		return "/api/v1/novtv/internal/compat/video/api/v3"
	case "audio":
		return "/api/v1/novtv/internal/compat/tts/v1"
	default:
		return ""
	}
}

func (c *Client) AdmitModel(config map[string]any, mode string) (map[string]any, error) {
	catalog, err := c.Catalog(context.Background())
	if err != nil {
		return nil, err
	}
	ref, _ := config["credentialRef"].(string)
	model, _ := config["model"].(string)
	if model == "" {
		model, _ = config["channelModelKey"].(string)
	}
	profile, ok := findProfile(catalog, ref, model, mode, "")
	if !ok || compatPath(profile.Capability) == "" || profile.Protocol == "" {
		return nil, errAuthorization
	}
	if _, err := c.authorizeSelection(context.Background(), app.ExternalModelSelection{CredentialRef: ref, Model: model, Protocol: profile.Protocol}, profile); err != nil {
		return nil, errAuthorization
	}
	next := make(map[string]any, len(config)+4)
	for key, value := range config {
		switch key {
		case "apiKey", "secretKey", "headers", "channelId", "baseUrl", "apiFormat", "interfaceType", "model", "capabilityConfig", "providerModelKey", "variantId":
			continue
		}
		next[key] = value
	}
	// Persist selection only. The short-lived proxy token is fetched by the
	// original executor after dequeue and is never added to the task snapshot.
	next["apiKey"], next["secretKey"], next["channelId"] = "", "", ""
	next["headers"] = []any{}
	next["credentialRef"] = ref
	next["baseUrl"] = c.baseURL + compatPath(profile.Capability)
	next["apiFormat"] = "openai"
	next["interfaceType"] = profile.Protocol
	next["model"] = model
	next["capabilityConfig"] = profile.CapabilityConfig
	if profile.Capability == "video" {
		for upstream, field := range map[string]string{"duration": "videoSeconds", "ratio": "size", "resolution": "vquality"} {
			if existing, _ := next[field].(string); existing == "" {
				if value, ok := profile.DefaultOptions[upstream]; ok {
					next[field] = fmt.Sprint(value)
				}
			}
		}
	}
	if profile.Capability == "audio" {
		for upstream, field := range map[string]string{"voice": "audioVoice", "response_format": "audioFormat", "speed": "audioSpeed"} {
			if existing, _ := next[field].(string); existing == "" {
				if value, ok := profile.DefaultOptions[upstream]; ok {
					next[field] = fmt.Sprint(value)
				}
			}
		}
		if next["audioVoice"] != "alloy" || next["audioFormat"] != "wav" || next["audioSpeed"] != "1" {
			return nil, app.BadAuthRequest("当前配音模型仅支持默认音色、WAV 和原速，请重新选择参数")
		}
		for field, neutral := range map[string]string{"audioInstructions": "", "audioPitch": "0", "audioVolume": "1"} {
			if value, exists := next[field]; exists && value != "" && value != neutral {
				return nil, app.BadAuthRequest("当前配音模型不支持音调、音量或额外指令")
			}
		}
	}
	return next, nil
}

func (c *Client) ResolveModel(ctx context.Context, selection app.ExternalModelSelection) (app.ExternalModelConnection, error) {
	catalog, err := c.Catalog(ctx)
	if err != nil {
		return app.ExternalModelConnection{}, err
	}
	profile, ok := findProfile(catalog, selection.CredentialRef, selection.Model, "", selection.Protocol)
	if !ok {
		return app.ExternalModelConnection{}, errAuthorization
	}
	return c.authorizeSelection(ctx, selection, profile)
}

func (c *Client) authorizeSelection(ctx context.Context, selection app.ExternalModelSelection, profile Profile) (app.ExternalModelConnection, error) {
	var connection struct {
		BaseURL string `json:"base_url"`
		APIKey  string `json:"api_key"`
	}
	body := map[string]string{"credential_ref": selection.CredentialRef, "model": selection.Model, "capability": profile.Capability, "protocol": profile.Protocol}
	if err := c.request(ctx, http.MethodPost, "/api/v1/novtv/internal/token", body, &connection); err != nil {
		return app.ExternalModelConnection{}, err
	}
	if connection.BaseURL != compatPath(profile.Capability) || connection.APIKey == "" {
		return app.ExternalModelConnection{}, errAuthorization
	}
	return app.ExternalModelConnection{BaseURL: c.baseURL + connection.BaseURL, APIKey: connection.APIKey,
		Headers: []app.OutboundHeader{{Name: "X-Novai-Bridge-Secret", Value: c.secret}}}, nil
}

func (c *Client) UploadMedia(ctx context.Context, media app.ExternalMediaUpload) (string, error) {
	if (media.Kind != "image" && media.Kind != "audio" && media.Kind != "video") || media.ResourceID == "" || media.Size <= 0 || media.Size > 64<<20 || media.Body == nil {
		return "", errAuthorization
	}
	switch media.MimeType {
	case "image/png", "image/jpeg", "image/webp", "audio/mpeg", "audio/wav", "audio/wave", "audio/x-wav", "audio/mp4", "audio/ogg", "video/mp4", "video/webm":
	default:
		return "", errAuthorization
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.baseURL+"/api/v1/novtv/internal/media", media.Body)
	if err != nil {
		return "", errAuthorization
	}
	c.mu.RLock()
	version := c.version
	c.mu.RUnlock()
	req.Header.Set("X-Novai-Bridge-Secret", c.secret)
	req.Header.Set("X-Novai-User-ID", c.userID)
	req.Header.Set("X-Novai-Credential-Version", version)
	req.Header.Set("X-Novai-Resource-ID", media.ResourceID)
	req.Header.Set("X-Novai-Media-Kind", media.Kind)
	req.Header.Set("Content-Type", media.MimeType)
	req.ContentLength = media.Size
	upload := &http.Client{Timeout: 2 * time.Minute, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	response, err := upload.Do(req)
	if err != nil {
		return "", errAuthorization
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return "", errAuthorization
	}
	var envelope struct {
		Code int `json:"code"`
		Data struct {
			URL string `json:"url"`
		} `json:"data"`
	}
	if json.NewDecoder(io.LimitReader(response.Body, 2048)).Decode(&envelope) != nil || envelope.Code != 0 || envelope.Data.URL == "" {
		return "", errAuthorization
	}
	return envelope.Data.URL, nil
}
