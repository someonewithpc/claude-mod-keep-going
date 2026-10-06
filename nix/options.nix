self: { lib, pkgs }:
{
  enable = lib.mkEnableOption "keep-going, the Claude Code mod that keeps unattended sessions going";

  package = lib.mkOption {
    type = lib.types.package;
    default = self.packages.${pkgs.stdenv.hostPlatform.system}.default;
    defaultText = lib.literalExpression "claude-mod-keep-going.packages.\${system}.default";
    description = "The mod's folder, loaded through CLAUDE_CODE_PLUGIN_DIRS.";
  };

  settings = lib.mkOption {
    type = (pkgs.formats.json { }).type;
    default = { };
    example = lib.literalExpression ''
      {
        compact = { enabled = true; trigger = "both"; minContextTokens = 100000; };
        modelFallback = { enabled = true; map = { Opus = "sonnet"; }; };
      }
    '';
    description = ''
      keep-going's configuration, written as JSON to claude-keep-going/config.json
      (see the README for the keys). Empty means no file is written.
    '';
  };
}
