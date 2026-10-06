{
  description = "Transcribe audio using Codex ChatGPT authentication";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs = { self, nixpkgs }:
    let
      systems = [ "x86_64-linux" "aarch64-linux" "x86_64-darwin" "aarch64-darwin" ];
      forAllSystems = nixpkgs.lib.genAttrs systems;
    in {
      packages = forAllSystems (system:
        let pkgs = import nixpkgs { inherit system; };
        in {
          default = pkgs.stdenvNoCC.mkDerivation {
            pname = "codex-transcribe";
            version = (builtins.fromJSON (builtins.readFile ./package.json)).version;
            src = self;
            nativeBuildInputs = [ pkgs.bun pkgs.makeWrapper ];
            # Runtime code has no external dependencies; no dependency download is needed.
            buildPhase = ''
              runHook preBuild
              bun build src/index.ts --target bun --outfile codex-transcribe.js
              runHook postBuild
            '';
            installPhase = ''
              runHook preInstall
              install -Dm644 codex-transcribe.js $out/libexec/codex-transcribe/index.js
              makeWrapper ${pkgs.bun}/bin/bun $out/bin/codex-transcribe \
                --add-flags "$out/libexec/codex-transcribe/index.js" \
                --prefix PATH : ${pkgs.lib.makeBinPath [ pkgs.ffmpeg-headless ]}
              runHook postInstall
            '';
            meta = {
              description = "Transcribe audio using Codex ChatGPT authentication";
              homepage = "https://github.com/nakasyou/codex-transcribe";
              license = pkgs.lib.licenses.mit;
              mainProgram = "codex-transcribe";
              platforms = systems;
            };
          };
        });
      apps = forAllSystems (system: {
        default = {
          type = "app";
          meta.description = "Transcribe audio using Codex ChatGPT authentication";
          program = "${self.packages.${system}.default}/bin/codex-transcribe";
        };
      });
      devShells = forAllSystems (system:
        let pkgs = import nixpkgs { inherit system; };
        in { default = pkgs.mkShell { packages = [ pkgs.bun pkgs.nodejs pkgs.ffmpeg-headless ]; }; });
    };
}
