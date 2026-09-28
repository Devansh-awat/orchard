package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"
)

var Version = "dev"

type multiFlag []string

func (m *multiFlag) String() string     { return strings.Join(*m, ",") }
func (m *multiFlag) Set(v string) error { *m = append(*m, v); return nil }

func env(name, fallback string) string {
	if v := os.Getenv(name); v != "" {
		return v
	}
	return fallback
}

func bucketFromEnv() (*Bucket, error) {
	b := &Bucket{
		Endpoint:  os.Getenv("R2_ENDPOINT"),
		Region:    env("R2_REGION", "auto"),
		Name:      os.Getenv("R2_BUCKET"),
		AccessKey: os.Getenv("R2_ACCESS_KEY"),
		SecretKey: os.Getenv("R2_SECRET_KEY"),
		Client:    &http.Client{Timeout: 60 * time.Second},
	}
	if b.Endpoint == "" && os.Getenv("R2_ACCOUNT_ID") != "" {
		b.Endpoint = "https://" + os.Getenv("R2_ACCOUNT_ID") + ".r2.cloudflarestorage.com"
	}
	var missing []string
	for name, value := range map[string]string{
		"R2_ENDPOINT (or R2_ACCOUNT_ID)": b.Endpoint,
		"R2_BUCKET":                      b.Name,
		"R2_ACCESS_KEY":                  b.AccessKey,
		"R2_SECRET_KEY":                  b.SecretKey,
	} {
		if value == "" {
			missing = append(missing, name)
		}
	}
	if len(missing) > 0 {
		return nil, errors.New("missing " + strings.Join(missing, ", "))
	}
	return b, nil
}

func keyPrefix() string {
	p := strings.Trim(os.Getenv("REGISTRY_PREFIX"), "/")
	if p == "" {
		return ""
	}
	return p + "/"
}

func usage() {
	fmt.Fprintf(os.Stderr, `registry serves an Orchard template registry out of an R2 bucket.

  registry serve                       serve the bucket over http (default)
  registry publish [flags]             validate templates and sync them to the bucket
  registry validate [flags]            validate templates without touching the bucket

publish and validate flags:
  -templates DIR   directory of <name>.yaml templates (repeatable)
  -files DIR       directory of extra files synced verbatim to the bucket root
  -source URL      prefix for linking templates back to git, e.g. https://github.com/hackclub/orchard/blob/main
  -version VER     catalogue version written to templates/index.json
  -git             record who added each template from git history (needs full history)
  -authors FILE    map git emails to GitHub logins, one "email login" per line
  -icons URL       favicon service template with a %%s placeholder for the homepage host, or "default"; stored as icon.png per version

environment:
  REGISTRY_LISTEN  address for serve (default :8080)
  REGISTRY_PREFIX  key prefix inside the bucket (default none)
  R2_ENDPOINT      https://<account>.r2.cloudflarestorage.com (or set R2_ACCOUNT_ID)
  R2_BUCKET        bucket name
  R2_ACCESS_KEY    access key id
  R2_SECRET_KEY    secret access key
  R2_REGION        signing region (default auto)
`)
}

func main() {
	log.SetFlags(0)
	command := "serve"
	args := os.Args[1:]
	if len(args) > 0 && !strings.HasPrefix(args[0], "-") {
		command, args = args[0], args[1:]
	}

	switch command {
	case "serve":
		serve()
	case "publish", "validate":
		fs := flag.NewFlagSet(command, flag.ExitOnError)
		var dirs multiFlag
		fs.Var(&dirs, "templates", "directory of <name>.yaml templates (repeatable)")
		files := fs.String("files", "", "directory of extra files synced verbatim")
		source := fs.String("source", "", "url prefix for linking templates back to their file in git")
		version := fs.String("version", "", "catalogue version recorded in templates/index.json")
		useGit := fs.Bool("git", false, "record who added each template from git history")
		authorsFile := fs.String("authors", "", "file mapping git emails to GitHub logins, one 'email login' per line")
		iconSource := fs.String("icons", "", "favicon service url template with %s for the homepage host; fetched once per version when no icon sidecar exists (use 'default' for "+defaultIconSource+")")
		fs.Parse(args)
		if len(dirs) == 0 {
			log.Fatal("at least one -templates directory is required")
		}
		if command == "validate" {
			if err := validateOnly(dirs); err != nil {
				log.Fatal(err)
			}
			return
		}
		bucket, err := bucketFromEnv()
		if err != nil {
			log.Fatal(err)
		}
		authors, err := loadAuthors(*authorsFile)
		if err != nil {
			log.Fatal(err)
		}
		if *iconSource == "default" {
			*iconSource = defaultIconSource
		}
		p := &publisher{bucket: bucket, prefix: keyPrefix(), sourceBase: *source, version: *version, icons: iconFetcherFromFlag(*iconSource), git: *useGit, authors: authors, now: time.Now, log: log.Default()}
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
		defer cancel()
		cat, err := p.run(ctx, dirs, *files)
		if err != nil {
			log.Fatal(err)
		}
		for _, t := range cat.Templates {
			log.Printf("published %-24s %-10s %s", t.Name, t.Version, t.Yaml)
		}
	case "version":
		fmt.Println(Version)
	case "help", "-h", "--help":
		usage()
	default:
		usage()
		os.Exit(2)
	}
}

func serve() {
	bucket, err := bucketFromEnv()
	if err != nil {
		log.Fatal(err)
	}
	srv := &http.Server{
		Addr:              env("REGISTRY_LISTEN", ":8080"),
		Handler:           newServer(bucket, keyPrefix()),
		ReadHeaderTimeout: 10 * time.Second,
	}
	go func() {
		log.Printf("registry %s serving bucket %s on %s", Version, bucket.Name, srv.Addr)
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Fatal(err)
		}
	}()
	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)
	<-stop
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	srv.Shutdown(ctx)
}
