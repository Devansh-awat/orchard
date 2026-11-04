package sshkey

import (
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/binary"
	"encoding/pem"
	"errors"
	"io"
	"strings"
)

const keyType = "ssh-ed25519"

func appendString(b []byte, s []byte) []byte {
	b = binary.BigEndian.AppendUint32(b, uint32(len(s)))
	return append(b, s...)
}

func publicBlob(pub ed25519.PublicKey) []byte {
	var b []byte
	b = appendString(b, []byte(keyType))
	return appendString(b, pub)
}

func AuthorizedKey(pub ed25519.PublicKey, comment string) string {
	line := keyType + " " + base64.StdEncoding.EncodeToString(publicBlob(pub))
	if comment = strings.TrimSpace(comment); comment != "" {
		line += " " + comment
	}
	return line
}

func MarshalPrivateKey(priv ed25519.PrivateKey, comment string, random io.Reader) ([]byte, error) {
	var check [4]byte
	if _, err := io.ReadFull(random, check[:]); err != nil {
		return nil, err
	}
	pub := priv.Public().(ed25519.PublicKey)

	var inner []byte
	inner = append(inner, check[:]...)
	inner = append(inner, check[:]...)
	inner = appendString(inner, []byte(keyType))
	inner = appendString(inner, pub)
	inner = appendString(inner, priv)
	inner = appendString(inner, []byte(comment))
	for i := byte(1); len(inner)%8 != 0; i++ {
		inner = append(inner, i)
	}

	var body []byte
	body = append(body, []byte("openssh-key-v1\x00")...)
	body = appendString(body, []byte("none"))
	body = appendString(body, []byte("none"))
	body = appendString(body, nil)
	body = binary.BigEndian.AppendUint32(body, 1)
	body = appendString(body, publicBlob(pub))
	body = appendString(body, inner)

	var out bytes.Buffer
	if err := pem.Encode(&out, &pem.Block{Type: "OPENSSH PRIVATE KEY", Bytes: body}); err != nil {
		return nil, err
	}
	return out.Bytes(), nil
}

func Generate(comment string) (privatePEM []byte, authorizedKey string, err error) {
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return nil, "", err
	}
	privatePEM, err = MarshalPrivateKey(priv, comment, rand.Reader)
	if err != nil {
		return nil, "", err
	}
	return privatePEM, AuthorizedKey(pub, comment), nil
}

func SameKey(a, b string) bool {
	fa, fb := strings.Fields(a), strings.Fields(b)
	if len(fa) < 2 || len(fb) < 2 {
		return false
	}
	return fa[0] == fb[0] && fa[1] == fb[1]
}

func readString(b []byte) ([]byte, []byte, bool) {
	if len(b) < 4 {
		return nil, nil, false
	}
	n := binary.BigEndian.Uint32(b)
	if uint64(n) > uint64(len(b)-4) {
		return nil, nil, false
	}
	return b[4 : 4+n], b[4+n:], true
}

func AuthorizedKeyFromPrivate(privatePEM []byte, comment string) (string, error) {
	block, _ := pem.Decode(privatePEM)
	if block == nil || block.Type != "OPENSSH PRIVATE KEY" {
		return "", errors.New("not an OpenSSH private key")
	}
	rest, ok := bytes.CutPrefix(block.Bytes, []byte("openssh-key-v1\x00"))
	if !ok {
		return "", errors.New("not an openssh-key-v1 private key")
	}
	for range 3 {
		if _, rest, ok = readString(rest); !ok {
			return "", errors.New("truncated private key")
		}
	}
	if len(rest) < 4 || binary.BigEndian.Uint32(rest) != 1 {
		return "", errors.New("private key must hold exactly one key")
	}
	blob, _, ok := readString(rest[4:])
	if !ok {
		return "", errors.New("truncated private key")
	}
	typ, keyRest, ok := readString(blob)
	if !ok || string(typ) != keyType {
		return "", errors.New("private key isn't ed25519")
	}
	pub, _, ok := readString(keyRest)
	if !ok || len(pub) != ed25519.PublicKeySize {
		return "", errors.New("malformed ed25519 public key")
	}
	return AuthorizedKey(ed25519.PublicKey(pub), comment), nil
}
