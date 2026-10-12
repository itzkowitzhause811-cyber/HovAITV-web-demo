package app

import (
	"encoding/json"
	"net/url"
	"strings"

	"infinite-canvas/backend/internal/hovaiapi"
)

const managedHovAIAPIRef = hovaiapi.CredentialRef

func (s *Service) SetHovAIAPI(connection *hovaiapi.Service) {
	if s == nil {
		return
	}
	s.hovAIAPI = connection
}

func (s *Service) HovAIAPI() *hovaiapi.Service {
	if s == nil {
		return nil
	}
	return s.hovAIAPI
}

func (s *Service) resolveManagedHovAIAPISecrets(input map[string]any) (map[string]any, error) {
	if input == nil {
		return input, nil
	}
	config, ok := input["config"].(map[string]any)
	if !ok {
		return input, nil
	}
	channelID := strings.TrimSpace(stringValue(config["channelId"]))
	credentialRef := strings.TrimSpace(stringValue(config["credentialRef"]))
	baseURL := strings.TrimSpace(stringValue(config["baseUrl"]))
	if !hovaiapi.IsManagedChannel(channelID, credentialRef, baseURL) && !s.hasLegacyHovAIAPIKey(channelID, baseURL) {
		return input, nil
	}
	apiKey, resolvedBase, accountID, tokenID, err := s.lookupHovAIAPICredential()
	if err != nil {
		return nil, err
	}
	if apiKey == "" {
		return input, nil
	}
	next := make(map[string]any, len(config)+4)
	for key, value := range config {
		switch key {
		case "apiKey", "credentialRef":
			continue
		default:
			next[key] = value
		}
	}
	if channelID == hovaiapi.ChannelID {
		delete(next, "channelId")
	}
	next["apiKey"] = apiKey
	if strings.TrimSpace(stringValue(next["baseUrl"])) == "" || hovaiapi.IsEnterpriseBaseURL(baseURL) || channelID == hovaiapi.ChannelID || credentialRef == managedHovAIAPIRef {
		next["baseUrl"] = resolvedBase
	}
	next["credentialRef"] = managedHovAIAPIRef
	if accountID != "" {
		next["managedAccountId"] = accountID
	}
	if tokenID != "" {
		next["managedTokenId"] = tokenID
	}
	input["config"] = next
	return input, nil
}

func (s *Service) lookupHovAIAPICredential() (apiKey, baseURL, accountID, tokenID string, err error) {
	if s.hovAIAPI != nil {
		if s.hovAIAPI.HasManagedCredential() {
			cred, resolveErr := s.hovAIAPI.Resolve()
			if resolveErr != nil {
				return "", "", "", "", BadAuthRequest(resolveErr.Error())
			}
			return cred.APIKey, cred.BaseURL, cred.AccountID, cred.TokenID, nil
		}
	}
	body, readErr := s.ReadLocalModelConfig()
	if readErr != nil || len(body) == 0 {
		return "", "", "", "", nil
	}
	var config struct {
		Channels []struct {
			ID      string `json:"id"`
			APIKey  string `json:"apiKey"`
			BaseURL string `json:"baseUrl"`
		} `json:"channels"`
	}
	if json.Unmarshal(body, &config) != nil {
		return "", "", "", "", nil
	}
	for _, channel := range config.Channels {
		if channel.ID == hovaiapi.ChannelID && strings.TrimSpace(channel.APIKey) != "" {
			base := strings.TrimSpace(channel.BaseURL)
			if base == "" {
				base = hovaiapi.ProductionOrigin
			}
			return channel.APIKey, base, "", "", nil
		}
	}
	return "", "", "", "", nil
}

func (s *Service) hasLegacyHovAIAPIKey(channelID, baseURL string) bool {
	if channelID != hovaiapi.ChannelID && !hovaiapi.IsEnterpriseBaseURL(baseURL) {
		return false
	}
	apiKey, _, _, _, err := s.lookupHovAIAPICredential()
	return err == nil && apiKey != ""
}

func (s *Service) resolveChannelModelsRequest(input *ChannelModelsRequest) error {
	if input == nil {
		return nil
	}
	if !hovaiapi.IsManagedChannel(input.ChannelID, input.CredentialRef, input.BaseURL) && input.ChannelID != hovaiapi.ChannelID {
		return nil
	}
	apiKey, baseURL, _, _, err := s.lookupHovAIAPICredential()
	if err != nil {
		return err
	}
	if apiKey == "" {
		return nil
	}
	input.APIKey = apiKey
	if strings.TrimSpace(input.BaseURL) == "" || hovaiapi.IsEnterpriseBaseURL(input.BaseURL) || input.ChannelID == hovaiapi.ChannelID {
		input.BaseURL = baseURL
	}
	input.CredentialRef = managedHovAIAPIRef
	return nil
}

func (s *Service) ResolveCustomRelayAPIKey(targetURL, incoming string) (string, error) {
	return s.resolveCustomRelayKey(targetURL, incoming)
}

func (s *Service) resolveCustomRelayKey(targetURL, incoming string) (string, error) {
	// An unrelated custom channel must remain usable even if the managed
	// connection is revoked. Resolve its secret only for the bound origin.
	if s.hovAIAPI != nil && s.hovAIAPI.HasManagedCredential() && !sameCredentialOrigin(targetURL, s.hovAIAPI.Origin()) {
		return incoming, nil
	}
	apiKey, baseURL, _, _, err := s.lookupHovAIAPICredential()
	if err != nil {
		return "", err
	}
	if apiKey == "" || !sameCredentialOrigin(targetURL, baseURL) {
		return incoming, nil
	}
	return apiKey, nil
}

func sameCredentialOrigin(targetURL, baseURL string) bool {
	target, targetErr := url.Parse(strings.TrimSpace(targetURL))
	base, baseErr := url.Parse(strings.TrimSpace(baseURL))
	if targetErr != nil || baseErr != nil || target.User != nil || base.User != nil || target.Host == "" || base.Host == "" {
		return false
	}
	if target.Scheme != "https" && target.Scheme != "http" {
		return false
	}
	return strings.EqualFold(target.Scheme, base.Scheme) && strings.EqualFold(target.Host, base.Host)
}

func (s *Service) noteHovAIAPIProviderError(message string) {
	if s == nil || s.hovAIAPI == nil {
		return
	}
	normalized := strings.ToLower(message)
	if strings.Contains(normalized, "unauthorized") || strings.Contains(message, "连接已失效") {
		s.hovAIAPI.MarkRevoked()
	}
	if strings.Contains(message, "额度不足") || strings.Contains(normalized, "insufficient") || strings.Contains(message, "余额不足") {
		s.hovAIAPI.MarkZeroBalance()
	}
}
