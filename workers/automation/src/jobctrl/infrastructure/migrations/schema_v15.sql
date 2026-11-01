-- A durable lifecycle generation fences reviewed destructive selections.
CREATE TABLE job_lifecycle_clock (
    singleton INTEGER NOT NULL PRIMARY KEY CHECK (singleton = 1),
    revision INTEGER NOT NULL CHECK (typeof(revision) = 'integer' AND revision >= 0)
);
INSERT INTO job_lifecycle_clock (singleton, revision) VALUES (1, 0);
CREATE TRIGGER job_lifecycle_clock_no_replace BEFORE INSERT ON job_lifecycle_clock
WHEN EXISTS (SELECT 1 FROM job_lifecycle_clock WHERE singleton = 1) BEGIN
    SELECT RAISE(ABORT, 'job lifecycle clock cannot be replaced');
END;
CREATE TRIGGER job_lifecycle_clock_no_delete BEFORE DELETE ON job_lifecycle_clock BEGIN
    SELECT RAISE(ABORT, 'job lifecycle clock cannot be removed');
END;
CREATE TRIGGER job_lifecycle_clock_monotonic BEFORE UPDATE ON job_lifecycle_clock
WHEN NEW.singleton != 1 OR typeof(NEW.revision) != 'integer' OR NEW.revision <= OLD.revision BEGIN
    SELECT RAISE(ABORT, 'job lifecycle clock must increase');
END;
CREATE TABLE job_lifecycle_revisions (
    tenant_id TEXT NOT NULL,
    job_id TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK (typeof(revision) = 'integer' AND revision >= 0),
    PRIMARY KEY (tenant_id, job_id),
    FOREIGN KEY (tenant_id, job_id) REFERENCES jobs(tenant_id, job_id) ON UPDATE CASCADE ON DELETE CASCADE
);
INSERT INTO job_lifecycle_revisions (tenant_id, job_id, revision)
SELECT tenant_id, job_id, 0 FROM jobs;

CREATE TRIGGER job_lifecycle_job_insert AFTER INSERT ON jobs BEGIN
    SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM job_lifecycle_clock WHERE singleton = 1)
        THEN RAISE(ABORT, 'job lifecycle clock is missing') END;
    UPDATE job_lifecycle_clock SET revision = revision + 1 WHERE singleton = 1;
    INSERT INTO job_lifecycle_revisions (tenant_id, job_id, revision)
    SELECT NEW.tenant_id, NEW.job_id, revision FROM job_lifecycle_clock
    WHERE singleton = 1 AND EXISTS (SELECT 1 FROM jobs WHERE tenant_id = NEW.tenant_id AND job_id = NEW.job_id)
    ON CONFLICT (tenant_id, job_id) DO UPDATE SET revision = excluded.revision;
END;

CREATE TRIGGER job_lifecycle_job_delete BEFORE DELETE ON jobs BEGIN
    SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM job_lifecycle_clock WHERE singleton = 1)
        THEN RAISE(ABORT, 'job lifecycle clock is missing') END;
    UPDATE job_lifecycle_clock SET revision = revision + 1 WHERE singleton = 1;
    DELETE FROM job_lifecycle_revisions WHERE tenant_id = OLD.tenant_id AND job_id = OLD.job_id;
END;

CREATE TRIGGER job_lifecycle_job_key_update AFTER UPDATE OF tenant_id, job_id ON jobs
WHEN OLD.tenant_id != NEW.tenant_id OR OLD.job_id != NEW.job_id BEGIN
    DELETE FROM job_lifecycle_revisions WHERE tenant_id = OLD.tenant_id AND job_id = OLD.job_id;
    SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM job_lifecycle_clock WHERE singleton = 1)
        THEN RAISE(ABORT, 'job lifecycle clock is missing') END;
    UPDATE job_lifecycle_clock SET revision = revision + 1 WHERE singleton = 1;
    INSERT INTO job_lifecycle_revisions (tenant_id, job_id, revision)
    SELECT NEW.tenant_id, NEW.job_id, revision FROM job_lifecycle_clock
    WHERE singleton = 1 AND EXISTS (SELECT 1 FROM jobs WHERE tenant_id = NEW.tenant_id AND job_id = NEW.job_id)
    ON CONFLICT (tenant_id, job_id) DO UPDATE SET revision = excluded.revision;
END;

CREATE TRIGGER job_lifecycle_deleted_insert AFTER INSERT ON jobctrl_deleted_jobs BEGIN
    SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM job_lifecycle_clock WHERE singleton = 1)
        THEN RAISE(ABORT, 'job lifecycle clock is missing') END;
    UPDATE job_lifecycle_clock SET revision = revision + 1 WHERE singleton = 1;
    INSERT INTO job_lifecycle_revisions (tenant_id, job_id, revision)
    SELECT NEW.tenant_id, NEW.job_id, revision FROM job_lifecycle_clock
    WHERE singleton = 1 AND EXISTS (SELECT 1 FROM jobs WHERE tenant_id = NEW.tenant_id AND job_id = NEW.job_id)
    ON CONFLICT (tenant_id, job_id) DO UPDATE SET revision = excluded.revision;
END;

CREATE TRIGGER job_lifecycle_deleted_update AFTER UPDATE ON jobctrl_deleted_jobs BEGIN
    SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM job_lifecycle_clock WHERE singleton = 1)
        THEN RAISE(ABORT, 'job lifecycle clock is missing') END;
    UPDATE job_lifecycle_clock SET revision = revision + 1 WHERE singleton = 1;
    INSERT INTO job_lifecycle_revisions (tenant_id, job_id, revision)
    SELECT NEW.tenant_id, NEW.job_id, revision FROM job_lifecycle_clock
    WHERE singleton = 1 AND EXISTS (SELECT 1 FROM jobs WHERE tenant_id = NEW.tenant_id AND job_id = NEW.job_id)
    ON CONFLICT (tenant_id, job_id) DO UPDATE SET revision = excluded.revision;
END;

CREATE TRIGGER job_lifecycle_deleted_delete AFTER DELETE ON jobctrl_deleted_jobs BEGIN
    SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM job_lifecycle_clock WHERE singleton = 1)
        THEN RAISE(ABORT, 'job lifecycle clock is missing') END;
    UPDATE job_lifecycle_clock SET revision = revision + 1 WHERE singleton = 1;
    INSERT INTO job_lifecycle_revisions (tenant_id, job_id, revision)
    SELECT OLD.tenant_id, OLD.job_id, revision FROM job_lifecycle_clock
    WHERE singleton = 1 AND EXISTS (SELECT 1 FROM jobs WHERE tenant_id = OLD.tenant_id AND job_id = OLD.job_id)
    ON CONFLICT (tenant_id, job_id) DO UPDATE SET revision = excluded.revision;
END;

CREATE TRIGGER job_lifecycle_deleted_move AFTER UPDATE OF tenant_id, job_id ON jobctrl_deleted_jobs
WHEN OLD.tenant_id != NEW.tenant_id OR OLD.job_id != NEW.job_id BEGIN
    SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM job_lifecycle_clock WHERE singleton = 1)
        THEN RAISE(ABORT, 'job lifecycle clock is missing') END;
    UPDATE job_lifecycle_clock SET revision = revision + 1 WHERE singleton = 1;
    INSERT INTO job_lifecycle_revisions (tenant_id, job_id, revision)
    SELECT OLD.tenant_id, OLD.job_id, revision FROM job_lifecycle_clock
    WHERE singleton = 1 AND EXISTS (SELECT 1 FROM jobs WHERE tenant_id = OLD.tenant_id AND job_id = OLD.job_id)
    ON CONFLICT (tenant_id, job_id) DO UPDATE SET revision = excluded.revision;
END;

CREATE TRIGGER job_lifecycle_hidden_insert AFTER INSERT ON jobctrl_hidden_jobs BEGIN
    SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM job_lifecycle_clock WHERE singleton = 1)
        THEN RAISE(ABORT, 'job lifecycle clock is missing') END;
    UPDATE job_lifecycle_clock SET revision = revision + 1 WHERE singleton = 1;
    INSERT INTO job_lifecycle_revisions (tenant_id, job_id, revision)
    SELECT NEW.tenant_id, NEW.job_id, revision FROM job_lifecycle_clock
    WHERE singleton = 1 AND EXISTS (SELECT 1 FROM jobs WHERE tenant_id = NEW.tenant_id AND job_id = NEW.job_id)
    ON CONFLICT (tenant_id, job_id) DO UPDATE SET revision = excluded.revision;
END;

CREATE TRIGGER job_lifecycle_hidden_update AFTER UPDATE ON jobctrl_hidden_jobs BEGIN
    SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM job_lifecycle_clock WHERE singleton = 1)
        THEN RAISE(ABORT, 'job lifecycle clock is missing') END;
    UPDATE job_lifecycle_clock SET revision = revision + 1 WHERE singleton = 1;
    INSERT INTO job_lifecycle_revisions (tenant_id, job_id, revision)
    SELECT NEW.tenant_id, NEW.job_id, revision FROM job_lifecycle_clock
    WHERE singleton = 1 AND EXISTS (SELECT 1 FROM jobs WHERE tenant_id = NEW.tenant_id AND job_id = NEW.job_id)
    ON CONFLICT (tenant_id, job_id) DO UPDATE SET revision = excluded.revision;
END;

CREATE TRIGGER job_lifecycle_hidden_delete AFTER DELETE ON jobctrl_hidden_jobs BEGIN
    SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM job_lifecycle_clock WHERE singleton = 1)
        THEN RAISE(ABORT, 'job lifecycle clock is missing') END;
    UPDATE job_lifecycle_clock SET revision = revision + 1 WHERE singleton = 1;
    INSERT INTO job_lifecycle_revisions (tenant_id, job_id, revision)
    SELECT OLD.tenant_id, OLD.job_id, revision FROM job_lifecycle_clock
    WHERE singleton = 1 AND EXISTS (SELECT 1 FROM jobs WHERE tenant_id = OLD.tenant_id AND job_id = OLD.job_id)
    ON CONFLICT (tenant_id, job_id) DO UPDATE SET revision = excluded.revision;
END;

CREATE TRIGGER job_lifecycle_hidden_move AFTER UPDATE OF tenant_id, job_id ON jobctrl_hidden_jobs
WHEN OLD.tenant_id != NEW.tenant_id OR OLD.job_id != NEW.job_id BEGIN
    SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM job_lifecycle_clock WHERE singleton = 1)
        THEN RAISE(ABORT, 'job lifecycle clock is missing') END;
    UPDATE job_lifecycle_clock SET revision = revision + 1 WHERE singleton = 1;
    INSERT INTO job_lifecycle_revisions (tenant_id, job_id, revision)
    SELECT OLD.tenant_id, OLD.job_id, revision FROM job_lifecycle_clock
    WHERE singleton = 1 AND EXISTS (SELECT 1 FROM jobs WHERE tenant_id = OLD.tenant_id AND job_id = OLD.job_id)
    ON CONFLICT (tenant_id, job_id) DO UPDATE SET revision = excluded.revision;
END;
