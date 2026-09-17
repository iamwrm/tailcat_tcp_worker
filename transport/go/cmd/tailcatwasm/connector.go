//go:build js && wasm

package main

import (
	"context"
	"net"
	"time"

	"github.com/tailscale/tailcat"
	"tailscale.com/types/key"
)

// Connect the raw TCP transport to a Tailcat service.
func connectTailcat(ctx context.Context, req *request) (net.Conn, func()) {
	ci, err := tailcat.ParseAddr(tailcat.Addr(req.Address))
	if err != nil || ci.ServerPublic.IsZero() || ci.ServerDiscoPublic.IsZero() || ci.PresharedKey.IsZero() {
		failure("invalid_tailcat_address", "Use a current tc address with a pre-shared key")
		return nil, nil
	}
	if len(ci.Region) != 0 && !req.AllowEmbedded {
		failure("embedded_relay_not_allowed", "Use the short Tailcat address, without --full-address")
		return nil, nil
	}
	cl := tailcat.NewClient(tailcat.Addr(req.Address))
	cl.Logf = func(string, ...any) {}
	cl.DERPMapURL = req.DERPMap
	if req.ClientKey != "" {
		var pk key.NodePrivate
		if err := pk.UnmarshalText([]byte(req.ClientKey)); err != nil || pk.IsZero() {
			cl.Close()
			failure("invalid_client_key", "Invalid optional Tailcat client identity")
			return nil, nil
		}
		cl.Key = pk
	}
	req.ClientKey, req.Address = "", ""
	dialCtx, cancel := context.WithTimeout(ctx, 40*time.Second)
	conn, err := cl.DialTCPPort(dialCtx, req.Port)
	cancel()
	if err != nil {
		cl.Close()
		if ctx.Err() != nil {
			failure("timeout", "Connection cancelled or timed out")
		} else {
			failure("tailcat_connection_failed", "Could not reach the Tailcat service")
		}
		return nil, nil
	}
	stop := context.AfterFunc(ctx, func() { conn.Close() })
	if deadline, ok := ctx.Deadline(); ok {
		conn.SetDeadline(deadline)
	}
	return conn, func() { stop(); conn.Close(); cl.Close() }
}
