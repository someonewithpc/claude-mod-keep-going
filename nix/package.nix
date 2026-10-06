{ lib, stdenvNoCC }:

# The mod is its folder: Claude Code reads the TypeScript itself, so there is
# nothing to build, only the files a plugin folder holds to copy.
stdenvNoCC.mkDerivation {
  pname = "claude-mod-keep-going";
  version = (builtins.fromJSON (builtins.readFile ../.claude-plugin/plugin.json)).version;

  src = lib.fileset.toSource {
    root = ../.;
    fileset = lib.fileset.unions [
      ../.claude-plugin/plugin.json
      ../hooks
      ../types
      ../README.md
      ../LICENSE
    ];
  };

  installPhase = ''
    runHook preInstall
    cp -r . $out
    runHook postInstall
  '';

  meta = {
    description = "Claude Code mod that keeps unattended sessions going through usage limits, API errors and full contexts";
    homepage = "https://github.com/someonewithpc/claude-mod-keep-going";
    license = lib.licenses.mit;
    platforms = lib.platforms.all;
  };
}
