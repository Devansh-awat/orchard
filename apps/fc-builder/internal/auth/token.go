package auth

import (
	"crypto/hmac"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"
)

const Audience = "fc-builder"

var (
	ErrMissing  = errors.New("missing bearer token")
	ErrMalformed = errors.New("malformed token")
	ErrSignature = errors.New("bad token signature")
	ErrExpired  = errors.New("token expired")
	ErrAudience = errors.New("token audience mismatch")
)

type header struct {
	Alg string `json:"alg"`
	Typ string `json:"typ,omitempty"`
}

type claims struct {
	Aud any   `json:"aud"`
	Exp int64 `json:"exp"`
	Iat int64 `json:"iat,omitempty"`
}

var b64 = base64.RawURLEncoding

func Sign(secret []byte, now time.Time, ttl time.Duration) string {
	h, _ := json.Marshal(header{Alg: "HS256", Typ: "JWT"})
	c, _ := json.Marshal(claims{Aud: Audience, Exp: now.Add(ttl).Unix(), Iat: now.Unix()})
	signing := b64.EncodeToString(h) + "." + b64.EncodeToString(c)
	return signing + "." + b64.EncodeToString(mac(secret, signing))
}

func Verify(secret []byte, token string, now time.Time) error {
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return ErrMalformed
	}
	hb, err := b64.DecodeString(parts[0])
	if err != nil {
		return ErrMalformed
	}
	var h header
	if json.Unmarshal(hb, &h) != nil || h.Alg != "HS256" {
		return ErrMalformed
	}
	sig, err := b64.DecodeString(parts[2])
	if err != nil {
		return ErrMalformed
	}
	if subtle.ConstantTimeCompare(sig, mac(secret, parts[0]+"."+parts[1])) != 1 {
		return ErrSignature
	}
	cb, err := b64.DecodeString(parts[1])
	if err != nil {
		return ErrMalformed
	}
	var c claims
	if json.Unmarshal(cb, &c) != nil {
		return ErrMalformed
	}
	if c.Exp == 0 || now.Unix() > c.Exp {
		return ErrExpired
	}
	if !audienceMatches(c.Aud) {
		return ErrAudience
	}
	return nil
}

func Middleware(secret []byte, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw := r.Header.Get("Authorization")
		token, ok := strings.CutPrefix(raw, "Bearer ")
		if !ok || token == "" {
			http.Error(w, ErrMissing.Error(), http.StatusUnauthorized)
			return
		}
		if err := Verify(secret, token, time.Now()); err != nil {
			http.Error(w, err.Error(), http.StatusUnauthorized)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func mac(secret []byte, data string) []byte {
	m := hmac.New(sha256.New, secret)
	m.Write([]byte(data))
	return m.Sum(nil)
}

func audienceMatches(aud any) bool {
	switch v := aud.(type) {
	case string:
		return v == Audience
	case []any:
		for _, a := range v {
			if s, ok := a.(string); ok && s == Audience {
				return true
			}
		}
	}
	return false
}
