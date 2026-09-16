//go:build js && wasm

package main

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log"
	"runtime"
	"runtime/debug"
	"syscall/js"
	"time"
)

type request struct {
	Address       string `json:"tailcat_address"`
	ClientKey     string `json:"tailcat_client_key,omitempty"`
	Port          uint16 `json:"port"`
	Timeout       int    `json:"timeout_seconds"`
	DERPMap       string `json:"derp_map_url"`
	AllowEmbedded bool   `json:"allow_embedded_relay"`
}

func emit(v any) {
	b, _ := json.Marshal(v)
	js.Global().Get("tailcatEmit").Invoke(string(b))
}

func failure(code, message string) {
	emit(map[string]any{"type": "error", "code": code, "message": message})
}

func main() {
	// Tailcat and its dependencies must never log addresses or request contents.
	log.SetOutput(io.Discard)
	debug.SetMemoryLimit(80 << 20)
	debug.SetGCPercent(50)
	var req request
	if err := json.Unmarshal([]byte(js.Global().Get("tailcatRequest").String()), &req); err != nil {
		failure("invalid_request", "Invalid request")
		return
	}
	js.Global().Set("tailcatRequest", "")
	if req.Timeout < 1 || req.Timeout > 3600 || req.Port == 0 {
		failure("invalid_request", "Invalid port or timeout")
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Duration(req.Timeout)*time.Second)
	defer cancel()
	cancelJS := js.FuncOf(func(js.Value, []js.Value) any { cancel(); return nil })
	js.Global().Set("cancelTailcat", cancelJS)
	defer func() { js.Global().Set("cancelTailcat", js.Undefined()); cancelJS.Release() }()
	if js.Global().Get("tailcatCancelled").Truthy() {
		cancel()
	}
	runTCP(ctx, &req)
	var m runtime.MemStats
	runtime.ReadMemStats(&m)
	emit(map[string]any{"type": "metrics", "go_heap_bytes": m.HeapAlloc, "go_sys_bytes": m.Sys})
}

// Promise callbacks only deliver a result. Blocking I/O happens in Go goroutines,
// never inside the JavaScript callback (which would stall the event loop).
func awaitJS(p js.Value) (js.Value, error) {
	type result struct {
		value js.Value
		err   error
	}
	done := make(chan result, 1)
	ok := js.FuncOf(func(_ js.Value, args []js.Value) any {
		value := js.Undefined()
		if len(args) > 0 {
			value = args[0]
		}
		done <- result{value: value}
		return nil
	})
	fail := js.FuncOf(func(js.Value, []js.Value) any { done <- result{err: errors.New("stream failed")}; return nil })
	p.Call("then", ok, fail)
	r := <-done
	ok.Release()
	fail.Release()
	return r.value, r.err
}
