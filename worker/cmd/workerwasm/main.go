//go:build js && wasm

package main

import (
	"context"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net"
	"runtime"
	"runtime/debug"
	"sync"
	"syscall/js"
	"time"

	"golang.org/x/crypto/ssh"
)

type request struct {
	TCP           bool   `json:"tcp"`
	Address       string `json:"tailcat_address"`
	ClientKey     string `json:"tailcat_client_key,omitempty"`
	User          string `json:"username"`
	PrivateKey    string `json:"private_key"`
	Passphrase    string `json:"passphrase,omitempty"`
	HostKey       string `json:"host_key_sha256"`
	Command       string `json:"command"`
	Shell         bool   `json:"shell"`
	Rows          int    `json:"rows"`
	Cols          int    `json:"cols"`
	Term          string `json:"term"`
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
	maxTimeout := 120
	if req.Shell || req.TCP {
		maxTimeout = 3600
	}
	if req.Timeout < 1 || req.Timeout > maxTimeout {
		req.Timeout = 30
	}
	if req.Port == 0 {
		req.Port = 22
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Duration(req.Timeout)*time.Second)
	defer cancel()
	if req.Shell {
		stop := context.AfterFunc(ctx, func() { js.Global().Get("tailcatUnblockOutput").Invoke() })
		defer stop()
	}
	cancelJS := js.FuncOf(func(js.Value, []js.Value) any { cancel(); return nil })
	js.Global().Set("cancelTailcat", cancelJS)
	defer func() { js.Global().Set("cancelTailcat", js.Undefined()); cancelJS.Release() }()
	if js.Global().Get("tailcatCancelled").Truthy() {
		cancel()
	}
	if req.TCP {
		runTCP(ctx, &req)
	} else {
		run(ctx, &req)
	}
	var m runtime.MemStats
	runtime.ReadMemStats(&m)
	emit(map[string]any{"type": "metrics", "go_heap_bytes": m.HeapAlloc, "go_sys_bytes": m.Sys})
}

func run(ctx context.Context, req *request) {
	var err error
	var signer ssh.Signer
	if req.Passphrase != "" {
		signer, err = ssh.ParsePrivateKeyWithPassphrase([]byte(req.PrivateKey), []byte(req.Passphrase))
	} else {
		signer, err = ssh.ParsePrivateKey([]byte(req.PrivateKey))
	}
	req.PrivateKey, req.Passphrase = "", ""
	if err != nil {
		failure("invalid_private_key", "Cannot read the SSH private key; encrypted keys need a passphrase")
		return
	}
	conn, cleanup := connectTailcat(ctx, req)
	if conn == nil {
		return
	}
	defer cleanup()
	hostMismatch := false
	sc, channels, requests, err := ssh.NewClientConn(conn, "tailcat-target", &ssh.ClientConfig{
		HostKeyAlgorithms: []string{ssh.KeyAlgoED25519},
		User:              req.User,
		Auth:              []ssh.AuthMethod{ssh.PublicKeys(signer)},
		HostKeyCallback: func(_ string, _ net.Addr, pk ssh.PublicKey) error {
			if subtle.ConstantTimeCompare([]byte(ssh.FingerprintSHA256(pk)), []byte(req.HostKey)) != 1 {
				hostMismatch = true
				return errors.New("host key mismatch")
			}
			return nil
		},
	})
	if err != nil {
		switch {
		case hostMismatch:
			failure("host_key_mismatch", "The SSH host key does not match the supplied fingerprint")
		case ctx.Err() != nil:
			failure("timeout", "SSH connection cancelled or timed out")
		default:
			failure("ssh_handshake_failed", "SSH authentication or handshake failed")
		}
		return
	}
	client := ssh.NewClient(sc, channels, requests)
	defer client.Close()
	session, err := client.NewSession()
	if err != nil {
		failure("ssh_session_failed", "Could not open an SSH session")
		return
	}
	defer session.Close()
	out := &outputBudget{remaining: 1 << 20, cancel: func() { conn.Close() }}
	if req.Shell {
		out.remaining = 16 << 20
		out.interactive = true
	}
	session.Stdout = &outputWriter{kind: "stdout", budget: out}
	session.Stderr = &outputWriter{kind: "stderr", budget: out}
	session.Stdin = nil
	if req.Shell {
		err = runShell(ctx, session, req, conn)
	} else {
		emit(map[string]any{"type": "status", "stage": "running"})
		err = session.Run(req.Command)
	}
	if out.exceeded {
		failure("output_limit", "Session exceeded its output limit")
		return
	}
	if ctx.Err() != nil {
		failure("timeout", "Command cancelled or timed out; a remote process may continue after disconnect")
		return
	}
	exit := 0
	if err != nil {
		var ee *ssh.ExitError
		if !errors.As(err, &ee) {
			failure("ssh_execution_failed", "SSH session ended without an exit status")
			return
		}
		exit = ee.ExitStatus()
	}
	emit(map[string]any{"type": "exit", "code": exit})
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

func runShell(ctx context.Context, session *ssh.Session, req *request, conn net.Conn) error {
	if err := session.RequestPty(req.Term, req.Rows, req.Cols, ssh.TerminalModes{ssh.ECHO: 1, ssh.TTY_OP_ISPEED: 38400, ssh.TTY_OP_OSPEED: 38400}); err != nil {
		return err
	}
	stdin, err := session.StdinPipe()
	if err != nil {
		return err
	}
	defer stdin.Close()
	if err := session.Shell(); err != nil {
		return err
	}
	emit(map[string]any{"type": "status", "stage": "running"})
	done := make(chan error, 1)
	go func() {
		var inputErr error
		defer func() {
			stdin.Close()
			if inputErr != nil {
				conn.Close()
			}
			done <- inputErr
		}()
		for {
			frame, err := awaitJS(js.Global().Get("tailcatRead").Invoke())
			if err != nil {
				inputErr = err
				return
			}
			switch frame.Get("type").String() {
			case "eof":
				return
			case "resize":
				if err := session.WindowChange(frame.Get("rows").Int(), frame.Get("cols").Int()); err != nil {
					inputErr = err
					return
				}
			case "input":
				value := frame.Get("data")
				data := make([]byte, value.Get("byteLength").Int())
				js.CopyBytesToGo(data, value)
				if _, err := stdin.Write(data); err != nil {
					inputErr = err
					return
				}
			}
		}
	}()
	err = session.Wait()
	// Settle pending reads and callbacks before shutting down this Go instance.
	stdin.Close()
	awaitJS(js.Global().Get("tailcatCloseInput").Invoke())
	<-done
	return err
}

type outputBudget struct {
	mu          sync.Mutex
	remaining   int
	exceeded    bool
	cancel      func()
	interactive bool
}
type outputWriter struct {
	kind   string
	budget *outputBudget
}

func (w *outputWriter) Write(p []byte) (int, error) {
	w.budget.mu.Lock()
	defer w.budget.mu.Unlock()
	if w.budget.interactive {
		if _, err := awaitJS(js.Global().Get("tailcatOutputReady").Invoke()); err != nil {
			return 0, err
		}
	}
	if len(p) > w.budget.remaining {
		w.budget.exceeded = true
		w.budget.cancel()
		return 0, errors.New("output limit")
	}
	w.budget.remaining -= len(p)
	emit(map[string]any{"type": w.kind, "encoding": "base64", "data": base64.StdEncoding.EncodeToString(p)})
	return len(p), nil
}
