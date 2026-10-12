package handler

import (
	"errors"
	"net/http"
	"time"

	"infinite-canvas/backend/internal/app"
	"infinite-canvas/backend/internal/hovaiapi"

	"github.com/gin-gonic/gin"
)

func RegisterHovAIAPIConnectionRoutes(r *gin.RouterGroup, svc *app.Service) {
	r.GET("/hovaiapi/connection", func(c *gin.Context) {
		if _, err := workspaceForLocalRequest(c, svc); err != nil {
			fail(c, http.StatusUnauthorized, err)
			return
		}
		connection, err := requestHovAIAPI(c, svc)
		if err != nil {
			failService(c, err)
			return
		}
		ok(c, connection.Status())
	})
	r.POST("/hovaiapi/connection/start", func(c *gin.Context) {
		if _, err := workspaceForLocalRequest(c, svc); err != nil {
			fail(c, http.StatusUnauthorized, err)
			return
		}
		if !enforceRateLimit(c, "hovaiapi-start", 10, time.Minute) {
			return
		}
		connection, err := requestHovAIAPI(c, svc)
		if err != nil {
			failService(c, err)
			return
		}
		summary, err := connection.Start(c.Request.Context())
		if err != nil && summary.State == "" {
			failService(c, app.BadAuthRequest(err.Error()))
			return
		}
		ok(c, summary)
	})
	r.POST("/hovaiapi/connection/cancel", func(c *gin.Context) {
		if _, err := workspaceForLocalRequest(c, svc); err != nil {
			fail(c, http.StatusUnauthorized, err)
			return
		}
		connection, err := requestHovAIAPI(c, svc)
		if err != nil {
			failService(c, err)
			return
		}
		summary, err := connection.Cancel(c.Request.Context())
		if err != nil {
			failService(c, err)
			return
		}
		ok(c, summary)
	})
	r.POST("/hovaiapi/connection/disconnect", func(c *gin.Context) {
		if _, err := workspaceForLocalRequest(c, svc); err != nil {
			fail(c, http.StatusUnauthorized, err)
			return
		}
		connection, err := requestHovAIAPI(c, svc)
		if err != nil {
			failService(c, err)
			return
		}
		summary, err := connection.Disconnect(c.Request.Context())
		if err != nil {
			failService(c, err)
			return
		}
		ok(c, summary)
	})
	r.POST("/hovaiapi/connection/open-wallet", func(c *gin.Context) {
		if _, err := workspaceForLocalRequest(c, svc); err != nil {
			fail(c, http.StatusUnauthorized, err)
			return
		}
		connection, err := requestHovAIAPI(c, svc)
		if err != nil {
			failService(c, err)
			return
		}
		if err := connection.OpenWallet(); err != nil {
			failService(c, err)
			return
		}
		ok(c, gin.H{"opened": true})
	})
}

func requestHovAIAPI(c *gin.Context, svc *app.Service) (*hovaiapi.Service, error) {
	if dependencies, ok := runtimeDependencies(c); ok && dependencies.HovAIAPI != nil {
		return dependencies.HovAIAPI, nil
	}
	if svc != nil {
		if connection := svc.HovAIAPI(); connection != nil {
			return connection, nil
		}
	}
	return nil, errors.New("企业连接服务尚未初始化")
}
