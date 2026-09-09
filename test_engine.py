"""Engine self-tests: rules, OUT, innings, chase, reset. Mirrors JS engine tests."""
import random
import pytest
from backend.game_engine import HandCricketEngine


def make(seed=0):
    return HandCricketEngine(random.Random(seed))


def start_batting_first(choice="bat"):
    e = make(1)
    e.start_toss()
    # force player win by calling correctly is random; just set directly
    e.state.toss_winner = "player"
    e.state.toss_call = "heads"
    e.state.toss_result = "heads"
    e.state.phase = "TOSS_RESULT"
    e.decide_after_toss(choice)
    return e


def test_runs_added_are_batsmans_not_bowlers():
    e = start_batting_first("bat")  # player bats
    out = e.resolve_ball(player_move=7, computer_move=3)
    assert out["runs"] == 7 and e.state.player_score == 7 and not out["is_out"]
    # now computer bats scenario
    e2 = start_batting_first("bowl")  # computer bats
    out2 = e2.resolve_ball(player_move=3, computer_move=7)
    assert out2["runs"] == 7 and e2.state.computer_score == 7


def test_out_on_equal():
    e = start_batting_first("bat")
    out = e.resolve_ball(5, 5)
    assert out["is_out"] and e.state.phase == "INNINGS_BREAK"
    assert e.state.target == e.state.player_score + 1


def test_chase_win_ends_immediately():
    e = start_batting_first("bat")
    e.resolve_ball(4, 2)   # player 4
    e.resolve_ball(4, 4)   # out, score 4, target 5
    assert e.state.target == 5
    e.continue_after_break()
    assert e.state.batting_side == "computer"
    r = e.resolve_ball(player_move=1, computer_move=5)  # computer bats 5 >= 5
    assert e.state.phase == "MATCH_RESULT" and e.state.winner == "computer"


def test_chase_out_defender_wins():
    e = start_batting_first("bat")
    e.resolve_ball(6, 1)
    e.resolve_ball(6, 6)  # out at 6, target 7
    e.continue_after_break()
    e.resolve_ball(player_move=7, computer_move=7)  # computer out chasing
    assert e.state.winner == "player" and e.state.phase == "MATCH_RESULT"


def test_no_extra_balls_after_result():
    e = start_batting_first("bat")
    e.resolve_ball(1, 2)
    e.resolve_ball(1, 1)
    e.continue_after_break()
    e.resolve_ball(player_move=9, computer_move=9)  # out -> result
    with pytest.raises(RuntimeError):
        e.resolve_ball(5, 3)


def test_invalid_moves_rejected():
    e = start_batting_first("bat")
    for bad in (11, -1):
        with pytest.raises(ValueError):
            e.resolve_ball(bad, 5)


def test_zero_is_valid_and_scores_bowlers_number_when_batting():
    e = start_batting_first("bat")  # player bats 0, computer bowls 7
    out = e.resolve_ball(player_move=0, computer_move=7)
    assert not out["is_out"] and out["runs"] == 7 and e.state.player_score == 7


def test_zero_vs_zero_is_out():
    e = start_batting_first("bat")
    out = e.resolve_ball(0, 0)
    assert out["is_out"] and e.state.phase == "INNINGS_BREAK"


def test_zero_vs_five_when_batting_scores_five():
    e = start_batting_first("bat")
    out = e.resolve_ball(player_move=0, computer_move=5)
    assert not out["is_out"] and out["runs"] == 5
