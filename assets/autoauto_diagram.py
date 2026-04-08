from manim import *
import numpy as np

# Color palette
BG = "#111111"
PRIMARY = "#58C4DD"      # Blue
GREEN = "#83C167"        # Keep/success
RED = "#FF6B6B"          # Discard/failure
YELLOW = "#FFFF00"       # Accent
DIM = "#444444"          # Muted
WHITE = "#E0E0E0"
SOFT_WHITE = "#AAAAAA"
ORANGE = "#FF9F43"

MONO = "JetBrains Mono"


class AutoAutoLoop(Scene):
    def construct(self):
        self.camera.background_color = BG

        # ════════════════════════════════════════════
        # PART 1a: Autoresearch — The Experiment Loop
        # ════════════════════════════════════════════

        ar_title = Text("Autoresearch", font_size=40, color=WHITE, weight=BOLD, font=MONO)
        ar_sub = Text(
            "Let AI iteratively improve your code against a metric",
            font_size=16, color=SOFT_WHITE, font=MONO
        )
        ar_title.move_to(UP * 2.8)
        ar_sub.next_to(ar_title, DOWN, buff=0.2)

        self.play(Write(ar_title), run_time=0.8)
        self.play(FadeIn(ar_sub, shift=UP * 0.15), run_time=0.5)

        # "The Experiment Loop" label + circular diagram
        loop_label = Text("The Experiment Loop", font_size=22, color=YELLOW,
                          weight=BOLD, font=MONO)
        loop_label.move_to(UP * 1.2)
        self.play(FadeIn(loop_label, shift=UP * 0.1), run_time=0.4)

        loop_center = DOWN * 1.0
        radius = 1.4
        node_info = [
            ("Agent", PRIMARY), ("Change", ORANGE),
            ("Measure", YELLOW), ("Decide", GREEN),
        ]
        desc_info = [
            "Fresh AI agent", "One change + commit",
            "Median of N runs", "Keep or discard",
        ]
        angles = [PI/2, 0, -PI/2, PI]

        nodes = VGroup()
        node_labels = VGroup()
        node_descs = VGroup()

        for i, ((name, color), desc_str) in enumerate(zip(node_info, desc_info)):
            angle = angles[i]
            pos = loop_center + radius * np.array([np.cos(angle), np.sin(angle), 0])
            circ = Circle(radius=0.4, stroke_color=color, stroke_width=2.5,
                          fill_color=BG, fill_opacity=1)
            circ.move_to(pos)
            lbl = Text(name, font_size=13, color=color, weight=BOLD, font=MONO)
            lbl.move_to(pos)
            desc = Text(desc_str, font_size=9, color=SOFT_WHITE, font=MONO)
            if i == 0:   desc.next_to(circ, RIGHT, buff=0.12)
            elif i == 1: desc.next_to(circ, DOWN, buff=0.12)
            elif i == 2: desc.next_to(circ, RIGHT, buff=0.12)
            else:        desc.next_to(circ, UP, buff=0.12)
            nodes.add(circ)
            node_labels.add(lbl)
            node_descs.add(desc)

        loop_arrows = VGroup()
        for i in range(4):
            # Connect edge-to-edge instead of center-to-center
            start = nodes[i].get_center()
            end = nodes[(i+1) % 4].get_center()
            direction = end - start
            direction = direction / np.linalg.norm(direction)
            arr = CurvedArrow(
                start + direction * 0.42,
                end - direction * 0.42,
                angle=-PI/3, stroke_width=1.5, color=DIM, tip_length=0.1
            )
            loop_arrows.add(arr)

        for i in range(4):
            # Draw arrow first, then circle+label on top so circle bg covers the line
            self.play(Create(loop_arrows[i]), run_time=0.15)
            self.play(FadeIn(nodes[i], scale=0.5), FadeIn(node_labels[i]), run_time=0.2)
            self.play(FadeIn(node_descs[i], shift=RIGHT * 0.1), run_time=0.15)

        self.wait(1.5)

        # ════════════════════════════════════════════
        # PART 1b: Autoresearch — Improvement chart
        # ════════════════════════════════════════════

        loop_all = VGroup(nodes, node_labels, node_descs, loop_arrows, loop_label)
        self.play(
            FadeOut(loop_all),
            FadeOut(ar_title), FadeOut(ar_sub),
            run_time=0.5
        )

        # Chart title area
        chart_title = Text("Improvement over time", font_size=24, color=WHITE,
                           weight=BOLD, font=MONO)
        chart_title.move_to(UP * 3.0)
        self.play(FadeIn(chart_title), run_time=0.4)

        # Chart — centered, larger
        chart_origin = DOWN * 0.2
        chart_w = 6.0
        chart_h = 3.5

        x_start = chart_origin + LEFT * chart_w/2 + DOWN * chart_h/2
        x_end = chart_origin + RIGHT * chart_w/2 + DOWN * chart_h/2
        y_end = chart_origin + LEFT * chart_w/2 + UP * chart_h/2

        x_axis = Line(x_start, x_end, stroke_width=1.5, color=DIM)
        y_axis = Line(x_start, y_end, stroke_width=1.5, color=DIM)

        x_lbl = Text("experiments", font_size=12, color=DIM, font=MONO)
        x_lbl.next_to(x_axis, DOWN, buff=0.12)
        y_lbl = Text("metric", font_size=12, color=DIM, font=MONO)
        y_lbl.next_to(y_axis, LEFT, buff=0.1).shift(UP * 0.3)
        lower_lbl = Text("lower is better", font_size=10, color=DIM, font=MONO)
        lower_lbl.next_to(y_lbl, DOWN, buff=0.25)

        self.play(
            Create(x_axis), Create(y_axis),
            FadeIn(x_lbl), FadeIn(y_lbl), FadeIn(lower_lbl),
            run_time=0.4
        )

        # Legend
        legend = VGroup(
            VGroup(Dot(radius=0.05, color=GREEN),
                   Text("keep", font_size=11, color=GREEN, font=MONO)).arrange(RIGHT, buff=0.1),
            VGroup(Dot(radius=0.05, color=RED),
                   Text("discard", font_size=11, color=RED, font=MONO)).arrange(RIGHT, buff=0.1),
        ).arrange(RIGHT, buff=0.4)
        legend.next_to(chart_title, DOWN, buff=0.15)
        self.play(FadeIn(legend), run_time=0.2)

        # Data
        experiments = [
            (0.85, False),
            (0.78, True),
            (0.82, False),
            (0.71, True),
            (0.73, False),
            (0.65, True),
            (0.60, True),
            (0.58, False),
            (0.48, True),
        ]

        baseline = 0.90
        current_baseline = baseline

        def metric_to_pos(idx, val):
            x = x_start[0] + (idx + 1) / (len(experiments) + 1) * chart_w
            y = x_start[1] + (1.0 - val) * chart_h
            return np.array([x, y, 0])

        # Baseline
        bl_y = x_start[1] + (1.0 - baseline) * chart_h
        bl_line = DashedLine(
            np.array([x_start[0], bl_y, 0]),
            np.array([x_end[0], bl_y, 0]),
            stroke_width=1, color=DIM, dash_length=0.08
        )
        bl_txt = Text("baseline", font_size=10, color=DIM, font=MONO)
        bl_txt.next_to(bl_line, RIGHT, buff=0.08)
        self.play(Create(bl_line), FadeIn(bl_txt), run_time=0.25)

        dots = VGroup()
        best_line = None
        best_label = None

        for i, (value, is_keep) in enumerate(experiments):
            pos = metric_to_pos(i, value)
            color = GREEN if is_keep else RED
            dot = Dot(pos, radius=0.08, color=color)

            if i > 0:
                prev_pos = metric_to_pos(i-1, experiments[i-1][0])
                conn = Line(prev_pos, pos, stroke_width=0.8, color=DIM)
                self.play(Create(conn), run_time=0.04)

            self.play(FadeIn(dot, scale=1.5), run_time=0.12)
            dots.add(dot)

            if is_keep:
                current_baseline = value
                new_y = x_start[1] + (1.0 - current_baseline) * chart_h
                new_bl = DashedLine(
                    np.array([x_start[0], new_y, 0]),
                    np.array([pos[0] + 0.5, new_y, 0]),
                    stroke_width=1, color=GREEN, dash_length=0.06
                )
                new_lbl = Text("best", font_size=10, color=GREEN, font=MONO)
                new_lbl.next_to(new_bl, LEFT, buff=0.08)

                if best_line:
                    self.play(
                        ReplacementTransform(best_line, new_bl),
                        ReplacementTransform(best_label, new_lbl),
                        run_time=0.12
                    )
                else:
                    self.play(Create(new_bl), FadeIn(new_lbl), run_time=0.12)
                best_line = new_bl
                best_label = new_lbl

        self.wait(0.3)

        # Result callout
        improvement = (baseline - current_baseline) / baseline * 100
        result_text = Text(
            f"{improvement:.0f}% improvement",
            font_size=26, color=GREEN, weight=BOLD, font=MONO
        )
        result_sub = Text(
            f"{len(experiments)} experiments  ·  {sum(1 for _,k in experiments if k)} kept  ·  {sum(1 for _,k in experiments if not k)} discarded",
            font_size=13, color=SOFT_WHITE, font=MONO
        )
        result_grp = VGroup(result_text, result_sub).arrange(DOWN, buff=0.12)
        result_grp.move_to(chart_origin + DOWN * 2.5)

        result_box = RoundedRectangle(
            corner_radius=0.1,
            width=result_grp.width + 0.5, height=result_grp.height + 0.3,
            stroke_color=GREEN, stroke_width=1.5, fill_color=BG, fill_opacity=0.95
        )
        result_box.move_to(result_grp)

        self.play(FadeIn(result_box), Write(result_text), FadeIn(result_sub), run_time=0.6)

        self.wait(1.5)

        # ════════════════════════════════════════════
        # PART 2: The problem
        # ════════════════════════════════════════════

        self.play(FadeOut(Group(*self.mobjects)), run_time=0.5)

        problem_title = Text("Looks simple, but...", font_size=28, color=RED,
                             weight=BOLD, font=MONO)
        problem_title.move_to(UP * 1.5)

        problems = [
            "Agents game the metric",
            "Measurement noise fakes progress",
            "Agents drift out of scope",
            "Same failed ideas tried repeatedly",
            "Stagnation burns money",
            "Environment drift poisons baseline",
            "Improving one metric breaks another",
        ]

        problem_texts = VGroup()
        for p in problems:
            t = Text(p, font_size=15, color=SOFT_WHITE, font=MONO)
            problem_texts.add(t)
        problem_texts.arrange(DOWN, buff=0.2, aligned_edge=LEFT)
        problem_texts.next_to(problem_title, DOWN, buff=0.4)

        self.play(FadeIn(problem_title), run_time=0.5)
        for pt in problem_texts:
            self.play(FadeIn(pt, shift=RIGHT * 0.2), run_time=0.25)

        self.wait(1.5)

        # ════════════════════════════════════════════
        # PART 3: AutoAuto handles it — three phases
        # ════════════════════════════════════════════

        self.play(FadeOut(Group(*self.mobjects)), run_time=0.5)

        aa_title = Text("AutoAuto", font_size=44, color=PRIMARY, weight=BOLD, font=MONO)
        aa_sub = Text(
            "handles all of this for you",
            font_size=18, color=SOFT_WHITE, font=MONO
        )
        aa_sub.next_to(aa_title, DOWN, buff=0.2)

        self.play(Write(aa_title), run_time=0.6)
        self.play(FadeIn(aa_sub, shift=UP * 0.1), run_time=0.4)
        self.wait(0.8)

        # Move to top-left
        aa_title_small = Text("AutoAuto", font_size=36, color=PRIMARY, weight=BOLD, font=MONO)
        aa_title_small.to_corner(UL, buff=0.4)

        self.play(
            ReplacementTransform(aa_title, aa_title_small),
            FadeOut(aa_sub),
            run_time=0.6
        )

        # Three phases — boxes with details that fade in below each
        phase_data = [
            ("1  Setup", "AI agent inspects your repo,\ndefines metric & measurement", PRIMARY),
            ("2  Execute", "Autonomous experiment loop\nwith built-in safeguards", YELLOW),
            ("3  Finalize", "Groups changes into\nclean branches", GREEN),
        ]

        detail_data = [
            [  # Setup details
                "Scans codebase for targets",
                "Generates measurement script",
                "Validates metric stability",
                "Defines scope constraints",
            ],
            [  # Execute details
                "Runs in background daemon",
                "Git worktree isolation",
                "Locked measurement files",
                "Auto-stops on stagnation",
            ],
            [  # Finalize details
                "Reviews accumulated diff",
                "Groups into clean branches",
                "Per-group risk assessment",
            ],
        ]

        phases = VGroup()
        for label_text, desc_text, color in phase_data:
            box = RoundedRectangle(
                corner_radius=0.15, width=3.6, height=1.5,
                stroke_color=color, stroke_width=2, fill_color=BG, fill_opacity=1
            )
            label = Text(label_text, font_size=22, color=color, weight=BOLD, font=MONO)
            desc = Text(desc_text, font_size=13, color=SOFT_WHITE, font=MONO,
                        line_spacing=0.6)
            label.move_to(box.get_top() + DOWN * 0.35)
            desc.move_to(box.get_center() + DOWN * 0.15)
            phase = VGroup(box, label, desc)
            phases.add(phase)

        phases.arrange(RIGHT, buff=0.4)
        phases.move_to(UP * 1.0)

        phase_arrows = VGroup()
        for i in range(2):
            arr = Arrow(
                phases[i].get_right(), phases[i+1].get_left(),
                buff=0.08, stroke_width=2.5, color=DIM, max_tip_length_to_length_ratio=0.2
            )
            phase_arrows.add(arr)

        for i, phase in enumerate(phases):
            self.play(FadeIn(phase, shift=UP * 0.2), run_time=0.35)
            if i < 2:
                self.play(Create(phase_arrows[i]), run_time=0.15)

        self.wait(1.0)

        # Fade in detail bullets below each phase
        detail_groups = VGroup()
        for i, (details, (_, _, color)) in enumerate(zip(detail_data, phase_data)):
            detail_texts = VGroup()
            for d in details:
                t = Text(f"> {d}", font_size=13, color=SOFT_WHITE, font=MONO)
                detail_texts.add(t)
            detail_texts.arrange(DOWN, buff=0.18, aligned_edge=LEFT)
            detail_texts.next_to(phases[i], DOWN, buff=0.3)
            detail_texts.move_to(
                np.array([phases[i].get_center()[0], detail_texts.get_center()[1], 0])
            )
            detail_groups.add(detail_texts)

        for i in range(3):
            self.play(
                *[FadeIn(d, shift=UP * 0.1) for d in detail_groups[i]],
                run_time=0.5
            )
            self.wait(0.3)

        self.wait(3.0)
        self.play(FadeOut(Group(*self.mobjects)), run_time=0.8)
        self.wait(0.2)
