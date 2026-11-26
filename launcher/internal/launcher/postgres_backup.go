package launcher

import (
	"archive/tar"
	"crypto/sha256"
	_ "embed"
	"encoding/hex"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/ebarti/jobctrl/launcher/internal/release"
)

const clusterArchive = "postgres.tar"
const pgIdentity = ".jobctrl-postgres-identity"

// A physical backup retains DBOS, application tables and their shared commit
// history. Only the cold, privately owned default-tablespace cluster is eligible.
func coldPostgres(data string) error {
	if err := validatePostgresVersion(data); err != nil {
		return err
	}
	if _, err := os.Lstat(filepath.Join(data, "postmaster.pid")); !errors.Is(err, os.ErrNotExist) {
		return errors.New("PostgreSQL is not demonstrably stopped; preserve the cluster and stop its owner")
	}
	return nil
}
func archivePostgres(data, dest string) error {
	if err := coldPostgres(data); err != nil {
		return err
	}
	output, err := os.OpenFile(dest, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		return err
	}
	defer output.Close()
	tw := tar.NewWriter(output)
	err = filepath.Walk(data, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		if path == data {
			return nil
		}
		if err := privatePostgresPath(path, info.IsDir()); err != nil {
			return err
		}
		relative, err := filepath.Rel(data, path)
		if err != nil {
			return err
		}
		if relative == "postmaster.pid" {
			return errors.New("PostgreSQL started during backup")
		}
		hdr := &tar.Header{Name: relative, Mode: 0600, Typeflag: tar.TypeReg, Size: info.Size()}
		if info.IsDir() {
			hdr.Typeflag = tar.TypeDir
			hdr.Mode = 0700
			hdr.Size = 0
		}
		if err := tw.WriteHeader(hdr); err != nil {
			return err
		}
		if info.IsDir() {
			return nil
		}
		f, err := os.OpenFile(path, os.O_RDONLY|syscall.O_NOFOLLOW, 0)
		if err != nil {
			return err
		}
		defer f.Close()
		opened, err := f.Stat()
		if err != nil || !os.SameFile(info, opened) {
			return errors.New("PostgreSQL file changed during backup")
		}
		_, err = io.Copy(tw, f)
		return err
	})
	if err != nil {
		return err
	}
	if err = tw.Close(); err != nil {
		return err
	}
	if err = coldPostgres(data); err != nil {
		return err
	}
	return output.Sync()
}
func unpackPostgres(archive, data string, pair databasePair) error {
	var expected databaseFile
	for _, file := range pair.Files {
		if file.Name == clusterArchive {
			expected = file
		}
	}
	file, err := os.OpenFile(archive, os.O_RDONLY|syscall.O_NOFOLLOW, 0)
	if err != nil {
		return err
	}
	defer file.Close()
	digest := sha256.New()
	stream := io.TeeReader(file, digest)
	tr := tar.NewReader(stream)
	for {
		hdr, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return err
		}
		if !filepath.IsLocal(hdr.Name) || filepath.Clean(hdr.Name) != hdr.Name || hdr.Name == "." || hdr.Name == "postmaster.pid" {
			return errors.New("invalid PostgreSQL backup member")
		}
		path := filepath.Join(data, hdr.Name)
		switch hdr.Typeflag {
		case tar.TypeDir:
			if err = os.Mkdir(path, 0700); err != nil {
				return err
			}
		case tar.TypeReg:
			f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL|syscall.O_NOFOLLOW, 0600)
			if err != nil {
				return err
			}
			_, writeErr := io.Copy(f, tr)
			if writeErr == nil {
				writeErr = f.Sync()
			}
			err = f.Close()
			if writeErr != nil {
				return writeErr
			}
			if err != nil {
				return err
			}
		default:
			return errors.New("PostgreSQL backup has unsupported external or special files")
		}
	}
	if _, err := io.Copy(io.Discard, stream); err != nil {
		return err
	}
	stat, err := file.Stat()
	if err != nil || stat.Size() != expected.SizeBytes || hex.EncodeToString(digest.Sum(nil)) != expected.SHA256 {
		return errors.New("staged PostgreSQL backup does not match verified checksum")
	}
	if err := filepath.Walk(data, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		if info.IsDir() {
			return syncDirectory(path)
		}
		return nil
	}); err != nil {
		return err
	}
	return coldPostgres(data)
}

// Resolve existing parent links before creating an output directory. Never let
// the backup archive become a member of the cluster being walked.
func validateBackupDestination(ctx launchContext, path string) error {
	absolute, err := filepath.Abs(path)
	if err != nil {
		return err
	}
	ancestor := absolute
	for {
		resolved, e := filepath.EvalSymlinks(ancestor)
		if e == nil {
			suffix, e := filepath.Rel(ancestor, absolute)
			if e != nil {
				return e
			}
			relative, e := filepath.Rel(postgresRoot(ctx), filepath.Join(resolved, suffix))
			if e != nil {
				return e
			}
			if relative == "." || filepath.IsLocal(relative) {
				return errors.New("backup destination must be outside managed PostgreSQL storage")
			}
			return nil
		}
		if !errors.Is(e, os.ErrNotExist) {
			return e
		}
		ancestor = filepath.Dir(ancestor)
	}
}

func snapshotPostgres(ctx launchContext, selection postgresSelection, receipt release.Receipt, parent string) (databasePair, error) {
	var empty databasePair
	if err := validateBackupDestination(ctx, parent); err != nil {
		return empty, err
	}
	if err := ensureSafeDirectory(parent); err != nil {
		return empty, err
	}
	id, err := releaseRandomID()
	if err != nil {
		return empty, err
	}
	// Publish complete archives together. Retention never treats a partial snapshot as a backup.
	stage, err := os.MkdirTemp(parent, ".pg-backup-")
	if err != nil {
		return empty, err
	}
	defer os.RemoveAll(stage)
	if err = privatePostgresPath(filepath.Join(ctx.Instance.StateDir, pgIdentity), false); err != nil {
		return empty, err
	}
	if err = copyRegular(filepath.Join(ctx.Instance.StateDir, pgIdentity), filepath.Join(stage, pgIdentity)); err != nil {
		return empty, err
	}
	if err = archivePostgres(selection.path(ctx), filepath.Join(stage, clusterArchive)); err != nil {
		return empty, err
	}
	pair := databasePair{SchemaVersion: 2, WorkspaceID: ctx.Instance.ID, ID: "pair-" + id, ReleaseReceipt: receipt, CreatedAt: time.Now().UTC()}
	for _, name := range []string{clusterArchive, pgIdentity} {
		f, e := describeDatabase(filepath.Join(stage, name), name, 0)
		if e != nil {
			return empty, e
		}
		pair.Files = append(pair.Files, f)
	}
	if err = writeJSONAtomic(filepath.Join(stage, "pair.json"), pair); err != nil {
		return empty, err
	}
	if err = os.Rename(stage, filepath.Join(parent, pair.ID)); err != nil {
		return empty, err
	}
	return pair, syncDirectory(parent)
}
func validPostgresPair(pair databasePair) bool {
	if pair.SchemaVersion != 2 || !sha256Pattern.MatchString(pair.WorkspaceID) || !strings.HasPrefix(pair.ID, "pair-") || !executionIDValid(strings.TrimPrefix(pair.ID, "pair-")) || !pair.ReleaseReceipt.Valid() || pair.CreatedAt.IsZero() || len(pair.Files) != 2 {
		return false
	}
	seen := map[string]bool{}
	for _, entry := range pair.Files {
		if (entry.Name != clusterArchive && entry.Name != pgIdentity) || !validSHA256(entry.SHA256) || entry.SizeBytes <= 0 || entry.SQLiteUserVer != 0 || entry.SQLiteApplicationID != 0 || seen[entry.Name] {
			return false
		}
		seen[entry.Name] = true
	}
	return true
}
func verifyPostgresPair(ctx launchContext, pair databasePair) error {
	if !validPostgresPair(pair) || pair.WorkspaceID != ctx.Instance.ID {
		return errors.New("invalid PostgreSQL backup authority")
	}
	root := filepath.Join(ctx.Instance.StateDir, "backups")
	dir := filepath.Join(root, pair.ID)
	for _, path := range []string{root, dir} {
		if err := privatePostgresPath(path, true); err != nil {
			return err
		}
	}
	for _, entry := range pair.Files {
		path := filepath.Join(dir, entry.Name)
		if err := privatePostgresPath(path, false); err != nil {
			return err
		}
		actual, err := describeDatabase(path, entry.Name, 0)
		if err != nil || entry != actual {
			return errors.New("PostgreSQL backup checksum or length differs")
		}
		if entry.Name == pgIdentity {
			actual, err = describeDatabase(filepath.Join(ctx.Instance.StateDir, pgIdentity), entry.Name, 0)
			if err != nil || entry != actual {
				return errors.New("PostgreSQL backup belongs to a different database binding")
			}
		}
	}
	return nil
}

// Compare approvals, submissions and charges without returning their contents.
// A live generation is read in one snapshot. Archived generations stay offline.
func postgresEffects(ctx launchContext, data string) (string, error) {
	operation := "effects"
	if _, err := os.Lstat(filepath.Join(data, "postmaster.pid")); err == nil {
		ctx.PostgresData = data
		if err := verifyPostmaster(ctx); err != nil {
			return "", err
		}
		operation = "effects-live"
	} else if err := coldPostgres(data); err != nil {
		return "", err
	}
	cmd := localCommand(ctx, migrationPython(ctx), "-I", "-B", "-c", postgresFileProof, postgresTool(ctx, "postgres"), data, ctx.Instance.StateDir, operation)
	out := &boundedProbeOutput{}
	cmd.Stdout = out
	if err := cmd.Run(); err != nil || !validSHA256(strings.TrimSpace(out.String())) {
		return "", errors.New("outstanding workflows, unresolved external effects or unverifiable PostgreSQL accounting prevent rollback")
	}
	return strings.TrimSpace(out.String()), nil
}

//go:embed postgres_file_proof.py
var postgresFileProof string

func verifyPostgresFiles(ctx launchContext, data string) error {
	if err := coldPostgres(data); err != nil {
		return err
	}
	cmd := localCommand(ctx, migrationPython(ctx), "-I", "-B", "-c", postgresFileProof, postgresTool(ctx, "postgres"), data, ctx.Instance.StateDir, "files")
	if err := cmd.Run(); err != nil {
		return errors.New("a PostgreSQL backup references missing, changed or unverified resume artifacts; live generation preserved")
	}
	return nil
}

func preflightPostgresRestore(ctx launchContext, pair databasePair) error {
	temp, err := os.MkdirTemp(postgresRoot(ctx), ".verify-restore-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(temp)
	archive := filepath.Join(ctx.Instance.StateDir, "backups", pair.ID, clusterArchive)
	if err := unpackPostgres(archive, temp, pair); err != nil {
		return err
	}
	if err := verifyPostgresFiles(ctx, temp); err != nil {
		return err
	}
	return matchPostgresEffects(ctx, temp)
}
func matchPostgresEffects(ctx launchContext, target string) error {
	current, err := readPostgresSelection(ctx, "active.json")
	if err != nil {
		return err
	}
	before, err := postgresEffects(ctx, current.path(ctx))
	if err != nil {
		return err
	}
	restored, err := postgresEffects(ctx, target)
	if err != nil {
		return err
	}
	if before != restored {
		return errors.New("restoring would revert approvals, submission or provider receipts; current generation preserved")
	}
	return nil
}
func restorePostgres(ctx launchContext, pair databasePair) error {
	if err := verifyPostgresPair(ctx, pair); err != nil {
		return err
	}
	current, err := readPostgresSelection(ctx, "active.json")
	if err != nil {
		return err
	}
	if err := coldPostgres(current.path(ctx)); err != nil {
		return err
	}
	before, err := postgresEffects(ctx, current.path(ctx))
	if err != nil {
		return err
	}
	generation, err := releaseRandomID()
	if err != nil {
		return err
	}
	target := postgresSelection{1, ctx.Instance.ID, generation}
	data := target.path(ctx)
	if err := os.Mkdir(data, 0700); err != nil {
		return err
	}
	// Keep the previous complete generation. The only authority change is an atomic pointer publication.
	if err := unpackPostgres(filepath.Join(ctx.Instance.StateDir, "backups", pair.ID, clusterArchive), data, pair); err != nil {
		return err
	}
	if err := verifyPostgresPair(ctx, pair); err != nil {
		return err
	}
	if err := verifyPostgresFiles(ctx, data); err != nil {
		return err
	}
	restored, err := postgresEffects(ctx, data)
	if err != nil {
		return err
	}
	if before != restored {
		return errors.New("a rollback would lose submission or model receipts; preserve the live generation")
	}
	// Refresh the marker inode to invalidate open editors with a pre-rollback database instance ID.
	marker := filepath.Join(ctx.Instance.StateDir, pgIdentity)
	temp := marker + "-" + generation
	if err := copyRegular(marker, temp); err != nil {
		return err
	}
	if err := os.Rename(temp, marker); err != nil {
		return err
	}
	if err := syncDirectory(ctx.Instance.StateDir); err != nil {
		return err
	}
	return writeJSONAtomic(filepath.Join(postgresRoot(ctx), "active.json"), target)
}
