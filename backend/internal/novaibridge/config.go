package novaibridge

import (
	"context"
	"encoding/json"

	"infinite-canvas/backend/internal/workspace"
)

// Config stores ordinary HovAITV preferences locally while the account model
// directory always comes from NovAI. Built-in provider presets are not merged
// into the platform model catalogue.
type Config struct {
	client *Client
	local  *workspace.ProviderConfig
}

func NewConfig(client *Client, dataDir string) (*Config, error) {
	local, err := workspace.NewProviderConfig(dataDir)
	if err != nil {
		return nil, err
	}
	return &Config{client: client, local: local}, nil
}

func (s *Config) ReadLocalModelConfig() ([]byte, error) {
	effective, _, err := s.LoadEffectiveModelConfig()
	if err != nil {
		return nil, err
	}
	return json.Marshal(effective.Config)
}

func (s *Config) LoadEffectiveModelConfig() (workspace.EffectiveModelConfig, workspace.ConfigHealth, error) {
	effective, health, err := s.local.LoadEffectiveModelConfig()
	if err != nil {
		return effective, health, err
	}
	catalog, err := s.client.Catalog(context.Background())
	if err != nil {
		return workspace.EffectiveModelConfig{}, health, err
	}
	raw, err := json.Marshal(catalog.Channels)
	if err != nil {
		return workspace.EffectiveModelConfig{}, health, err
	}
	var channels []any
	if err := json.Unmarshal(raw, &channels); err != nil {
		return workspace.EffectiveModelConfig{}, health, err
	}
	effective.Config["channels"] = channels
	effective.Config["apiKey"] = ""
	effective.Config["baseUrl"] = "/api/ai/system/novai"
	effective.Config["apiFormat"] = "openai"
	for field, value := range map[string]string{"audioFormat": catalog.AudioFormat, "audioVoice": catalog.AudioVoice, "audioSpeed": catalog.AudioSpeed} {
		if existing, _ := effective.Config[field].(string); existing == "" && value != "" {
			effective.Config[field] = value
		}
	}
	effective.PresetVersions = map[string]int{}
	return effective, health, nil
}

func preferenceBody(body []byte) ([]byte, error) {
	var config map[string]any
	if err := json.Unmarshal(body, &config); err != nil {
		return nil, err
	}
	// Model connection fields are owned by the server directory. UI edits cannot
	// replace an account's credential binding or install another provider key.
	delete(config, "channels")
	delete(config, "apiKey")
	delete(config, "secretKey")
	delete(config, "baseUrl")
	delete(config, "headers")
	delete(config, "credentialRef")
	return json.Marshal(config)
}

func (s *Config) SaveLocalModelConfig(body []byte) error {
	preferences, err := preferenceBody(body)
	if err != nil {
		return err
	}
	return s.local.SaveLocalModelConfig(preferences)
}

func (s *Config) SaveLocalModelConfigRevision(body []byte, expected int64) (int64, error) {
	preferences, err := preferenceBody(body)
	if err != nil {
		return 0, err
	}
	return s.local.SaveLocalModelConfigRevision(preferences, expected)
}
