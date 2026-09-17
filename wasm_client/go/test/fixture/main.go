// Local protocol fixture: real DERP, WireGuard, TCP forwarding, and SSH.
// It accepts only generated test keys and fixed synthetic commands.
package main

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/tailscale/tailcat"
	"golang.org/x/crypto/ssh"
	"tailscale.com/derp/derpserver"
	"tailscale.com/tailcfg"
	"tailscale.com/types/key"
	"tailscale.com/types/logger"
)

func must(err error) {
	if err != nil {
		panic(err)
	}
}
func newSigner() (ssh.Signer, []byte) {
	_, pk, err := ed25519.GenerateKey(rand.Reader)
	must(err)
	signer, err := ssh.NewSignerFromKey(pk)
	must(err)
	block, err := ssh.MarshalPrivateKey(pk, "ephemeral integration test")
	must(err)
	return signer, pem.EncodeToMemory(block)
}
func main() {
	log.SetOutput(io.Discard)
	hostKey, _ := newSigner()
	userKey, userPEM := newSigner()
	_, wrongPEM := newSigner()
	var execCount atomic.Int32
	var halfCloseBytes atomic.Int64
	config := &ssh.ServerConfig{PublicKeyCallback: func(meta ssh.ConnMetadata, pub ssh.PublicKey) (*ssh.Permissions, error) {
		if meta.User() != "test-user" || !bytes.Equal(pub.Marshal(), userKey.PublicKey().Marshal()) {
			return nil, fmt.Errorf("denied")
		}
		return &ssh.Permissions{}, nil
	}}
	config.AddHostKey(hostKey)
	sshListener, err := net.Listen("tcp", "127.0.0.1:0")
	must(err)
	defer sshListener.Close()
	go func() {
		for {
			c, err := sshListener.Accept()
			if err != nil {
				return
			}
			go serveSSH(c, config, &execCount)
		}
	}()

	d := derpserver.New(key.NewNode(), logger.Discard)
	defer d.Close()
	relay, err := net.Listen("tcp", "127.0.0.1:0")
	must(err)
	region := &tailcfg.DERPRegion{RegionID: 901, RegionCode: "test", Nodes: []*tailcfg.DERPNode{{Name: "test1", RegionID: 901, HostName: "127.0.0.1", IPv4: "127.0.0.1", IPv6: "none", DERPPort: relay.Addr().(*net.TCPAddr).Port, STUNPort: -1, InsecureForTests: true}}}
	dm := &tailcfg.DERPMap{Regions: map[tailcfg.DERPRegionID]*tailcfg.DERPRegion{901: region}}
	mux := http.NewServeMux()
	mux.HandleFunc("/hello", func(w http.ResponseWriter, r *http.Request) { io.WriteString(w, "HTTP through generic TCP\n") })
	mux.Handle("/derp", derpserver.AddWebSocketSupport(d, derpserver.Handler(d)))
	mux.HandleFunc("/map", func(w http.ResponseWriter, r *http.Request) { json.NewEncoder(w).Encode(dm) })
	mux.HandleFunc("/stats", func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(map[string]any{"executions": execCount.Load(), "half_close_bytes": halfCloseBytes.Load()})
	})
	server := &http.Server{Handler: mux}
	go server.Serve(relay)
	defer server.Close()
	if os.Getenv("PUBLIC_DERP") == "1" {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		publicMap, err := tailcat.FetchDERPMap(ctx)
		must(err)
		id, err := tailcat.PickBestRegion(ctx, publicMap)
		must(err)
		region = publicMap.Regions[id]
		if region == nil {
			panic("No public relay selected")
		}
	}
	sftpPort, _ := strconv.Atoi(os.Getenv("TEST_SFTP_PORT"))
	if sftpPort < 1 || sftpPort > 65535 {
		sftpPort = 0
	}
	tc := &tailcat.Server{Region: region, Logf: logger.Discard}
	tc.OnTCP = func(port uint16) func(net.Conn) {
		if port == 7001 {
			return func(c net.Conn) { defer c.Close(); io.Copy(c, c) }
		}
		if port == 7002 {
			return func(c net.Conn) {
				defer c.Close()
				h := sha256.New()
				io.Copy(h, io.LimitReader(c, 64<<20))
				fmt.Fprintf(c, "%x", h.Sum(nil))
			}
		}
		if port == 7003 {
			return func(c net.Conn) {
				defer c.Close()
				io.WriteString(c, "server-fin\n")
				c.(interface{ CloseWrite() error }).CloseWrite()
				n, _ := io.Copy(io.Discard, c)
				halfCloseBytes.Store(n)
			}
		}
		if port == 7004 {
			return func(c net.Conn) {
				defer c.Close()
				for i := 0; i < 16; i++ {
					if _, err := c.Write(bytes.Repeat([]byte{byte(i)}, 16384)); err != nil {
						return
					}
				}
				c.(interface{ CloseWrite() error }).CloseWrite()
				io.Copy(io.Discard, c)
			}
		}
		if port == 7005 {
			return func(c net.Conn) { defer c.Close(); io.Copy(io.Discard, c) }
		}
		if port != 22 && port != 80 && !(port == 7006 && sftpPort != 0) {
			return nil
		}
		return func(c net.Conn) {
			defer c.Close()
			targetAddr := sshListener.Addr().String()
			if port == 7006 {
				targetAddr = net.JoinHostPort("127.0.0.1", strconv.Itoa(sftpPort))
			}
			if port == 80 {
				targetAddr = relay.Addr().String()
			}
			target, err := net.Dial("tcp", targetAddr)
			if err != nil {
				return
			}
			defer target.Close()
			done := make(chan struct{})
			go func() { io.Copy(target, c); target.(*net.TCPConn).CloseWrite(); close(done) }()
			io.Copy(c, target)
			c.(interface{ CloseWrite() error }).CloseWrite()
			<-done
		}
	}
	must(tc.Start())
	defer tc.Close()
	ci, err := tailcat.ParseAddr(tc.TailcatAddr())
	must(err)
	ci.RegionID = region.RegionID
	ci.Region = nil
	json.NewEncoder(os.Stdout).Encode(map[string]any{
		"host_key_public": string(ssh.MarshalAuthorizedKey(hostKey.PublicKey())), "tailcat_address": string(ci.Addr()), "username": "test-user", "private_key": string(userPEM), "wrong_private_key": string(wrongPEM), "host_key_sha256": ssh.FingerprintSHA256(hostKey.PublicKey()), "command": "probe", "map_url": "http://" + relay.Addr().String() + "/map", "stats_url": "http://" + relay.Addr().String() + "/stats",
	})
	signalChan := make(chan os.Signal, 1)
	signal.Notify(signalChan, os.Interrupt, syscall.SIGTERM)
	<-signalChan
}

func serveSSH(c net.Conn, config *ssh.ServerConfig, execCount *atomic.Int32) {
	defer c.Close()
	conn, channels, requests, err := ssh.NewServerConn(c, config)
	if err != nil {
		return
	}
	defer conn.Close()
	go ssh.DiscardRequests(requests)
	for incoming := range channels {
		if incoming.ChannelType() != "session" {
			incoming.Reject(ssh.UnknownChannelType, "session only")
			continue
		}
		channel, reqs, err := incoming.Accept()
		if err != nil {
			return
		}
		go func() {
			defer channel.Close()
			var pty struct {
				Term                      string
				Cols, Rows, Width, Height uint32
				Modes                     string
			}
			hasPTY := false
			for req := range reqs {
				if req.Type == "pty-req" {
					hasPTY = ssh.Unmarshal(req.Payload, &pty) == nil
					req.Reply(hasPTY, nil)
					continue
				}
				if req.Type == "window-change" {
					var size struct{ Cols, Rows, Width, Height uint32 }
					if ssh.Unmarshal(req.Payload, &size) == nil {
						fmt.Fprintf(channel, "resize:%dx%d\n", size.Rows, size.Cols)
					}
					continue
				}
				if req.Type == "shell" && hasPTY {
					execCount.Add(1)
					req.Reply(true, nil)
					fmt.Fprintf(channel, "PTY ready:%dx%d\n", pty.Rows, pty.Cols)
					go func() {
						defer channel.Close()
						buf := make([]byte, 4096)
						for {
							n, err := channel.Read(buf)
							if err != nil {
								return
							}
							if bytes.Contains(buf[:n], []byte("exit\n")) {
								channel.SendRequest("exit-status", false, ssh.Marshal(struct{ Code uint32 }{0}))
								return
							}
							if bytes.Contains(buf[:n], []byte("flood\n")) {
								for i := 0; i < 8; i++ {
									if _, err := channel.Write(bytes.Repeat([]byte("x"), 32768)); err != nil {
										return
									}
								}
								io.WriteString(channel, "FLOW_DONE\n")
								continue
							}
							if bytes.Contains(buf[:n], []byte{3}) {
								io.WriteString(channel, "interrupted\n")
							} else {
								channel.Write(append([]byte("echo:"), buf[:n]...))
							}
						}
					}()
					continue
				}
				if req.Type != "exec" {
					req.Reply(false, nil)
					continue
				}
				var payload struct{ Command string }
				if ssh.Unmarshal(req.Payload, &payload) != nil {
					req.Reply(false, nil)
					return
				}
				execCount.Add(1)
				req.Reply(true, nil)
				var exit uint32
				switch payload.Command {
				case "cat":
					io.Copy(channel, channel)
				case "probe":
					io.WriteString(channel, "hello from SSH through Tailcat\n")
					io.WriteString(channel.Stderr(), "stderr is separate\n")
					exit = 7
				case "unicode":
					channel.Write([]byte{0xf0, 0x9f})
					channel.Write([]byte{0x90, 0x88, 10})
				case "slow":
					time.Sleep(4 * time.Second)
					io.WriteString(channel, "finished\n")
				case "flood":
					for i := 0; i < 80; i++ {
						if _, err := channel.Write(bytes.Repeat([]byte("x"), 16384)); err != nil {
							return
						}
					}
				default:
					exit = 127
				}
				channel.SendRequest("exit-status", false, ssh.Marshal(struct{ Code uint32 }{exit}))
				return
			}
		}()
	}
}
