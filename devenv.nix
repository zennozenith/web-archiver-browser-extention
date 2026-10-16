{pkgs, ...}: {
  env.GREET = "devenv";

  packages = [
    pkgs.git
    pkgs.librsvg
    pkgs.bash
    pkgs.zip
    pkgs.jq
  ];

  tasks."build:all" = {
    exec = "./build.sh";
  };

  languages = {
    typescript.enable = true;
    javascript = {
      enable = true;
      bun.enable = true;
      nodejs.enable = false;
      lsp.enable = false;
    };
  };
}
