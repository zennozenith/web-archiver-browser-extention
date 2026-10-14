{
  pkgs,
  lib,
  config,
  inputs,
  ...
}: {
  env.GREET = "devenv";

  packages = [pkgs.git];

  languages.typescript.enable = true;
  languages.javascript = {
    enable = true;
    bun.enable = true;
    nodejs.enable = false;
    lsp.enable = false;
  };
}
