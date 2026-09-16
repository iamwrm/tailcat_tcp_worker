//go:build js && wasm

package main

import (
	"context"
	"errors"
	"io"
	"syscall/js"
	"time"
)

func runTCP(ctx context.Context, req *request) {
	conn, cleanup := connectTailcat(ctx, req)
	if conn == nil {
		return
	}
	defer cleanup()
	closeWrite, ok := conn.(interface{ CloseWrite() error })
	if !ok {
		failure("half_close_unavailable", "Connector does not support TCP half-close")
		return
	}
	read := js.Global().Get("transportRead")
	consumed := js.Global().Get("transportConsumed")
	write := js.Global().Get("transportWrite")
	stopIO := js.Global().Get("transportStop")
	unblock := func() { stopIO.Invoke() }
	stop := context.AfterFunc(ctx, unblock)
	defer stop()
	emit(map[string]any{"type": "opened", "version": 1, "window": 65536, "max_frame": 16384})
	done := make(chan error, 1)
	go func() {
		buf := make([]byte, 16384)
		var inputErr error
		defer func() {
			if inputErr != nil {
				conn.Close()
				unblock()
			}
			done <- inputErr
		}()
		for {
			frame, err := awaitJS(read.Invoke())
			if err != nil {
				inputErr = err
				return
			}
			if frame.IsNull() {
				inputErr = closeWrite.CloseWrite()
				return
			}
			data := buf[:frame.Get("byteLength").Int()]
			js.CopyBytesToGo(data, frame)
			for len(data) > 0 {
				n, err := conn.Write(data)
				if err != nil {
					inputErr = err
					return
				}
				if n == 0 {
					inputErr = io.ErrShortWrite
					return
				}
				consumed.Invoke(n)
				data = data[n:]
			}
		}
	}()
	buf := make([]byte, 16384)
	data := js.Global().Get("Uint8Array").New(len(buf))
	var outputErr error
	for {
		n, err := conn.Read(buf)
		if n > 0 {
			js.CopyBytesToJS(data, buf[:n])
			if _, e := awaitJS(write.Invoke(data, n)); e != nil {
				outputErr = e
				break
			}
		}
		if err != nil {
			if !errors.Is(err, io.EOF) {
				outputErr = err
			} else {
				emit(map[string]any{"type": "fin"})
			}
			break
		}
	}
	if outputErr != nil {
		conn.Close()
		unblock()
	}
	inputErr := <-done
	if ctx.Err() != nil {
		failure("timeout", "Transport cancelled or timed out")
		return
	}
	if inputErr != nil || outputErr != nil {
		failure("tcp_io_failed", "TCP stream ended unexpectedly")
		return
	}
	// Both application directions ended, but TCP may still have queued data.
	// Wait for the final TCP acknowledgement before destroying the netstack.
	drain, ok := conn.(interface{ WaitWriteClosed(context.Context) error })
	if !ok {
		failure("drain_unavailable", "Connector cannot confirm TCP shutdown")
		return
	}
	drainCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	if err := drain.WaitWriteClosed(drainCtx); err != nil {
		failure("tcp_drain_failed", "TCP shutdown was not acknowledged")
		return
	}
	emit(map[string]any{"type": "closed"})
}
