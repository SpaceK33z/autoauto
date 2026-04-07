# What Karpathy's Autoresearch Unlocked for Me

- **Author:** Jonathan Barazany (Chief AI at Nayax)
- **Published:** 2026-03-15
- **URL:** https://barazany.dev/blog/what-karpathys-autoresearch-unlocked-for-me

---

I'm not a data scientist. I've trained a few models before — simple classification problems, with AI writing the Python and me running the iterations. It worked. I got confident.

Then a friend asked for help with something harder.

## Three Weeks at 0.58

The problem involved predicting an outcome from a mix of CRM data and call recordings. Not trivial, but not exotic either.

Quick primer on AUC — the metric I'll use throughout. Imagine your model looks at two random people: one where the answer is yes, one where it's no. AUC measures how often the model correctly ranks the yes above the no. Score of 0.5 means random guessing. Score of 1.0 means always right.

I tried everything I knew: XGBoost, feature engineering, extracting features from transcripts using AI models, trying different combinations. I assumed more data meant better results — that's how it's supposed to work. Instead, every time I added more features, the AUC dropped. Below 0.5 sometimes. Meaning the model was now actively misleading — it would've been better to ignore it entirely and flip a coin.

My ceiling was 0.581. I couldn't break it no matter what I did.

I stepped away from the problem for a week. Talked it through with a friend who actually knows this domain. Nothing clicked. I was out of moves.

Then Karpathy [posted about autoresearch](https://github.com/karpathy/autoresearch).

## The Gold Wasn't the Model

The post generated a ton of hype. For two days I kept asking myself: how do I use what he built on my problem? His project was about training a small language model — not a classification problem like mine. On the surface, nothing transferred.

But that was the wrong question. The interesting part wasn't what Karpathy was training. It was *how*. A fixed, uncheat-able validation metric. An agent that modifies only the training script. A loop that runs while you sleep. The scientific method, automated.

I had a problem sitting unfinished. I had the method. I started a tmux session from my iPhone on Friday night and let it run.

## Experiment 30: The Rubber Duck

The agent started simple — tuning hyperparameters on a single XGBoost model. By experiment 30, it declared it had exhausted all options.

I didn't accept that. But I also couldn't follow what it had done. So I just asked questions. What have you tried? Walk me through your thinking.

I wasn't guiding it toward an answer. I was just making it talk.

That conversation unlocked something. The agent proposed stacking — running multiple models in parallel and feeding their outputs into a meta-learner as a second layer of training. AUC jumped from 0.581 to 0.628. Something I had no chance of reaching on my own — I didn't even know this technique existed.

A few times after that, the agent hit a wall again. Each time, I either gave it new ideas from my own research or simply told it to keep testing combinations. That dynamic — agent explores, hits a ceiling, human nudges, agent continues — repeated itself throughout the entire run.

## 165 Experiments Later

Here's what the agent built, step by step, from the data I already had:

| Stage | AUC | What changed |
|-------|-----|-------------|
| Baseline | 0.581 | Single XGBoost, 10 features |
| +Stacking | 0.628 | 5 models stacked, meta-learner added |
| +Temporal features | 0.654 | Year, quarter, month |
| +CatBoost | 0.669 | New base model with target encoding |
| +Better cross-validation | 0.669 | 20-fold instead of fewer |
| Simplified meta-features | 0.670 | Less is more |
| Removed redundant feature | **0.6719** | Cleaner signal to the meta-learner |

Total gain: +15.6%. From a dataset I was ready to abandon.

The agent's own summary at the end of the run: *"The remaining gap is small — we need something fundamentally new."*

So I asked it to go find that. One prompt: use your agents to research the topic and come up with new ideas.

It spawned a research agent, ran for just over a minute, and came back with five ranked ideas. Then immediately started implementing the first one — temporal decay weights, the idea that older data should matter less than recent data. No waiting for my approval. No hand-holding.

First experiment: **0.6727**. New best. It tweaked one parameter. **0.6731**. Better. Tweaked it again. **0.6747**. Still climbing.

This is where I'm at as I write this. The agent is still running.

## The Method Changes Everything

I'm not ready to declare this problem solved. We need higher AUC before this is useful in production — probably 0.75 or better. And I genuinely don't know yet if the data we have can get us there.

But I no longer feel like I'm out of ideas. That's new.

We're in an era where something published on a Tuesday can unblock a problem you abandoned the week before. The tool that didn't exist yesterday is the reason you're making progress today. Staying close to what's emerging isn't optional anymore — it's the edge.

We have similar problems at Nayax waiting to be tackled. They'll be approached differently now.
