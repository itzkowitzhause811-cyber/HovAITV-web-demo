package app

import "context"
import "io"

// ModelConfigSource keeps the displayed catalogue and generation admission on
// the same account-scoped source. The desktop store remains the default.
type ModelConfigSource interface {
	ReadLocalModelConfig() ([]byte, error)
	SaveLocalModelConfig([]byte) error
}

type ExternalModelSelection struct {
	CredentialRef string
	Model         string
	Protocol      string
}

type ExternalModelConnection struct {
	BaseURL string
	APIKey  string
	Headers []OutboundHeader
}

type ExternalMediaUpload struct {
	ResourceID string
	Kind       string
	MimeType   string
	Size       int64
	Body       io.Reader
}

// ExternalMediaUploader stages only a previously owned, ready local resource
// for URL-only protocols. It does not accept arbitrary request URLs or data.
type ExternalMediaUploader interface {
	UploadMedia(context.Context, ExternalMediaUpload) (string, error)
}

// ExternalModelProvider only binds model selection and transport credentials.
// It never receives or rewrites a prompt, conversation or provider payload.
type ExternalModelProvider interface {
	AdmitModel(map[string]any, string) (map[string]any, error)
	ResolveModel(context.Context, ExternalModelSelection) (ExternalModelConnection, error)
}

func (s *Service) SetExternalModels(provider ExternalModelProvider, source ModelConfigSource) {
	s.externalModels = provider
	s.modelConfigSource = source
}

func (s *Service) resolveExternalProviderConfig(config providerConfig) (providerConfig, error) {
	connection, err := s.externalModels.ResolveModel(context.Background(), ExternalModelSelection{
		CredentialRef: config.CredentialRef, Model: config.Model, Protocol: config.InterfaceType,
	})
	if err != nil {
		return providerConfig{}, BadAuthRequest("平台模型授权不可用，请重新登录或刷新模型目录")
	}
	config.ChannelID = ""
	config.BaseURL = connection.BaseURL
	config.APIKey = connection.APIKey
	config.SecretKey = ""
	config.Headers = connection.Headers
	return config, nil
}
