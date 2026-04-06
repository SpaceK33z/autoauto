# Andrej Karpathy's new open source 'autoresearch' lets you run hundreds of AI experiments a night — with revolutionary implications

*Source: [Venturebeat](https://venturebeat.com/ai/andrej-karpathys-new-open-source-autoresearch-lets-you-run-hundreds-of-ai)*

Over the weekend, Andrej Karpathy—the influential former Tesla AI lead and co-founder and former member of OpenAI who coined the term "vibe coding"— posted on X about his new open source project, autoresearch.

It wasn't a finished model or a massive corporate product: it was by his own admission a simple, 630-line script made available on Github under a permissive, enterprise-friendly MIT License. But the ambition was massive: automating the scientific method with AI agents while us humans sleep.

"The goal is to engineer your agents to make the fastest research progress indefinitely and without any of your own involvement," he stated on X.

The system functions as an autonomous optimization loop. An AI agent is given a training script and a fixed compute budget (typically 5 minutes on a GPU).

It reads its own source code, forms a hypothesis for improvement (such as changing a learning rate or an architecture depth), modifies the code, runs the experiment, and evaluates the results.

If the validation loss—measured in bits per byte (val_bpb)—improves, it keeps the change; if not, it reverts and tries again. In one overnight run, Karpathy’s agent completed 126 experiments, driving loss down from 0.9979 to 0.9697.

Today, Karpathy reported that after leaving the agent to tune a "depth=12" model for two days, it successfully processed approximately 700 autonomous changes.

The agent found roughly 20 additive improvements that transferred perfectly to larger models. Stacking these changes dropped the "Time to GPT-2" metric on the leaderboard from 2.02 hours to 1.80 hours—an 11% efficiency gain on a project Karpathy believed was already well-tuned.

"Seeing the agent do this entire workflow end-to-end and all by itself... is wild," Karpathy remarked, noting that the agent caught oversights in attention scaling and regularization that he had missed manually over two decades of work.

This is more than just a productivity hack; it is a fundamental shift in how intelligence is refined. By automating the "scientific method" for code, Karpathy has turned machine learning into an evolutionary process that runs at the speed of silicon rather than the speed of human thought.

And more than this, it showed the broader AI and machine learning community on X that this type of process could be applied far beyond computer science, to fields like marketing, health, and, well, basically anything that requires research.

## Autoresearch spreads far and wide

The reaction was swift and viral, with Karpathy's post garnering more than 8.6 million views in the intervening two days as builders and researchers scrambled to scale the "Karpathy loop".

Varun Mathur, CEO of AI tool aggregator platform Hyperspace AI, took the single-agent loop and distributed it across a peer-to-peer network. Every node running the Hyperspace agent became an autonomous researcher.

On the night of March 8–9, 35 autonomous agents on the Hyperspace network ran 333 experiments completely unsupervised. The results were a masterclass in emergent strategy:

Hardware Diversity as a Feature: Mathur noted that while H100 GPUs used "brute force" to find aggressive learning rates, CPU-only agents on laptops were forced to be clever. These "underdog" agents focused on initialization strategies (like Kaiming and Xavier init) and normalization choices because they couldn't rely on raw throughput.

Gossip-Based Discovery: Using the GossipSub protocol, agents shared their wins in real-time. When one agent found that Kaiming initialization dropped loss by 21%, the idea spread through the network like a digital virus. Within hours, 23 other agents had incorporated the discovery into their own hypotheses.

The Compression of History: In just 17 hours, these agents independently rediscovered ML milestones—such as RMSNorm and tied embeddings—that took human researchers at labs like Google Brain and OpenAI nearly eight years to formalize.

## Run 36,500 marketing experiments each year instead of 30

While the ML purists focused on loss curves, the business world saw a different kind of revolution. Eric Siu, founder of ad agency Single Grain, applied autoresearch to the "Experiment Loop" of marketing.

"Most marketing teams run ~30 experiments a year," Siu wrote on X. "The next generation will run 36,500+. Easily." He continued:

"They'll run experiments while they sleep. Current marketing teams run 20-30 experiments a year. Maybe 52 if they're 'good'. New landing page. New ad creative. Maybe a subject line test. That's considered "data-driven marketing." But the next generation of marketing systems will run 36,500+ experiments per year."

Siu’s framework replaces the training script with a marketing asset—a landing page, an ad creative, or a cold email. The agent modifies a variable (the subject line or the CTA), deploys it, measures the "positive reply rate," and keeps or discards.

Siu argues that this creates a "proprietary map" of what resonates with a specific audience—a moat built not of code, but of experiment history. "The companies that win won't have better marketers," he wrote, "they'll have faster experiment loops".

## Community discussion and 'spoiling' the validation set

Despite the fervor, the GitHub Discussions revealed a community grappling with the implications of such rapid, automated progress.

The Over-Optimization Trap: Researcher alexisthual raised a poignant concern: "Aren't you concerned that launching that many experiments will eventually 'spoil' the validation set?". The fear is that with enough agents, parameters will be optimized for the specific quirks of the test data rather than general intelligence.

The Meaning of the Gains: User samionb questioned whether a drop from 0.9979 to 0.9697 was truly noticeable. Karpathy’s response was characteristically direct: "All we're doing is optimizing performance per compute... these are real and substantial gains"

The Human Element: On X, user witcheer, Head of Growth at crypto platform Yari Finance, documented their own overnight run on a Mac Mini M4, noting that while 26 of 35 experiments failed or crashed, the seven that succeeded revealed that "the model got better by getting simpler".

This insight—that less is often more—was reached without a single human intervention.

## The future: curiosity as the bottleneck

The release of autoresearch suggests a future of research across domains where, thanks to simple AI instruction mechanisms, the role of the human shifts from "experimenter" to "experimental designer."

As tools like DarkMatter, Optimization Arena, and NanoClaw emerge to support this swarm, the bottleneck of AI progress is no longer the "meat computer's" (Karpathy's description of the human brain's) ability to code—it is our ability to define the constraints of the search.

Andrej Karpathy has once again shifted the vibe. We are no longer just coding models; we are seeding ecosystems that learn while we sleep.
