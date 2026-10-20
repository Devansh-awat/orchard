package auth

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestSignVerifyRoundTrip(t *testing.T) {
	secret := []byte("s3cret")
	now := time.Unix(1_800_000_000, 0)
	tok := Sign(secret, now, time.Minute)
	if err := Verify(secret, tok, now.Add(30*time.Second)); err != nil {
		t.Fatalf("verify: %v", err)
	}
}

func TestVerifyRejects(t *testing.T) {
	secret := []byte("s3cret")
	now := time.Unix(1_800_000_000, 0)
	tok := Sign(secret, now, time.Minute)
	cases := map[string]struct {
		secret []byte
		token  string
		at     time.Time
		want   error
	}{
		"wrong secret": {[]byte("other"), tok, now, ErrSignature},
		"expired":      {secret, tok, now.Add(2 * time.Minute), ErrExpired},
		"garbage":      {secret, "a.b", now, ErrMalformed},
		"tampered":     {secret, tok[:len(tok)-2] + "AA", now, ErrSignature},
	}
	for name, tc := range cases {
		if err := Verify(tc.secret, tc.token, tc.at); err != tc.want {
			t.Errorf("%s: got %v want %v", name, err, tc.want)
		}
	}
}

func TestVerifyAcceptsServerIssuedToken(t *testing.T) {
	secret := []byte("fc-builder-test-secret")
	tok := "eyJhbGciOiJIUzI1NiJ9.eyJhdWQiOiJmYy1idWlsZGVyIiwiaWF0IjoxODAwMDAwMDAwLCJleHAiOjE4MDAwMDAwNjB9.dR4ulZFFlERfmNb8VJFLLKWPTKN1eyDL8ETvu0kr-Q8"
	if err := Verify(secret, tok, time.Unix(1_800_000_030, 0)); err != nil {
		t.Fatalf("server-shaped token rejected: %v", err)
	}
	if err := Verify(secret, tok, time.Unix(1_800_000_061, 0)); err != ErrExpired {
		t.Fatalf("expected expiry, got %v", err)
	}
}

func TestMiddleware(t *testing.T) {
	secret := []byte("s3cret")
	h := Middleware(secret, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest("GET", "/", nil))
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("no token: got %d", rec.Code)
	}
	req := httptest.NewRequest("GET", "/", nil)
	req.Header.Set("Authorization", "Bearer "+Sign(secret, time.Now(), time.Minute))
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("valid token: got %d", rec.Code)
	}
}
