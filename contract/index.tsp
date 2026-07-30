// Barrel entrypoint: imports the shared base types and every phase contract so
// the whole project compiles and emits a unified schema set. main.tsp stays
// free of imports (rule: base types only); phases import main.tsp individually.
import "./main.tsp";
import "./phases/00-cli-parse.tsp";
import "./phases/01-workspace-setup.tsp";
import "./phases/02-repo-clone.tsp";
import "./phases/03-pack-install.tsp";
import "./phases/04-home-isolation.tsp";
import "./phases/04b-pack-setup.tsp";
import "./phases/05-preflight.tsp";
import "./phases/06-run-side.tsp";
import "./phases/07-aggregate.tsp";
import "./phases/08-diff.tsp";
import "./phases/09-judge.tsp";
import "./phases/10-timeline.tsp";
import "./phases/11-report-render.tsp";
import "./phases/12-review-workspace.tsp";
import "./phases/13-cleanup.tsp";
