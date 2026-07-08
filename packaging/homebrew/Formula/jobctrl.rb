# frozen_string_literal: true

# Homebrew formula for the JobCtrl launcher.
#
# Canonical home of this file is packaging/homebrew/Formula/jobctrl.rb in the
# JobCtrl repository; the ebarti/homebrew-tap copy is published from here at
# release time (see docs/publish-checklist.md, step 9.5).
#
# Until the first public tag exists, install straight from a checkout:
#   brew install --formula packaging/homebrew/Formula/jobctrl.rb --HEAD
class Jobctrl < Formula
  desc "Local-first job search mission control: discover, score, tailor, apply"
  homepage "https://jobctrl.dev"
  license "AGPL-3.0-only"

  # TODO(release): add a stable spec at the first public tag, e.g.
  #   url "https://github.com/ebarti/JobCtrl/archive/refs/tags/v2.0.0.tar.gz"
  #   sha256 "<sha256 of that tarball>"
  head "https://github.com/ebarti/JobCtrl.git", branch: "main"

  depends_on "git"
  depends_on "node"
  depends_on "poppler"
  depends_on "temporal"
  depends_on "uv"

  def install
    libexec.install "scripts/get" => "get"
    # bin/jobctrl ends up as a prefix symlink, so bake the absolute libexec
    # path into the launcher instead of resolving it relative to $0.
    inreplace "scripts/jobctrl-launcher", "@JOBCTRL_LIBEXEC_GET@", (libexec/"get").to_s
    bin.install "scripts/jobctrl-launcher" => "jobctrl"
  end

  def caveats
    <<~EOS
      jobctrl is a launcher: the app itself runs from a source checkout that
      stays under your control (default: ~/JobCtrl, override with JOBCTRL_HOME).

      First run:
        jobctrl bootstrap   # clone + guided install
        jobctrl init && jobctrl doctor
        jobctrl dev         # full local stack; Ctrl-C stops it

      Browser automation and PDF rendering also want Google Chrome or Chromium:
        brew install --cask google-chrome
    EOS
  end

  test do
    assert_match "JobCtrl launcher", shell_output("#{bin}/jobctrl --help")
    # bootstrap must resolve the baked libexec bootstrap script through the
    # bin symlink (regression: unresolved $0 pointed at an unlinked libexec).
    assert_match "Clones JobCtrl to $JOBCTRL_HOME",
                 shell_output("#{bin}/jobctrl bootstrap --help")
  end
end
