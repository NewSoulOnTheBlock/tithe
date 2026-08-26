// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IYieldAdapter} from "../interfaces/IYieldAdapter.sol";

/// @dev Stands in for the Pons-deployed LOYAL: plain, fixed-supply, burnable.
contract MockLoyal is ERC20 {
    constructor(uint256 supply) ERC20("Loyal", "LOYAL") {
        _mint(msg.sender, supply);
    }

    function burn(uint256 amount) external {
        _burn(msg.sender, amount);
    }
}

/**
 * @dev A yield adapter whose value can be pushed up (yield) or down
 *      (impermanent loss) so the Treasury's floor-regression path is testable.
 *      Mirrors the real high-water-mark rule from spec §9.
 */
contract MockAdapter is IYieldAdapter {
    uint256 public assets;
    uint256 public principalHighWaterMark;

    receive() external payable {}

    function deposit() external payable {
        assets += msg.value;
        principalHighWaterMark += msg.value;
    }

    function withdraw(uint256 amount) external returns (uint256) {
        uint256 send = amount > assets ? assets : amount;
        assets -= send;
        if (send > principalHighWaterMark) {
            principalHighWaterMark = 0;
        } else {
            principalHighWaterMark -= send;
        }
        (bool ok, ) = msg.sender.call{value: send}("");
        require(ok, "MockAdapter: send failed");
        return send;
    }

    function realizeSurplus() external returns (uint256) {
        if (assets <= principalHighWaterMark) return 0;
        uint256 surplus = assets - principalHighWaterMark;
        assets -= surplus;
        (bool ok, ) = msg.sender.call{value: surplus}("");
        require(ok, "MockAdapter: send failed");
        return surplus;
    }

    function totalAssets() external view returns (uint256) {
        return assets;
    }

    /// @dev The high-water mark: moves only on principal in/out, never on price.
    function principal() external view returns (uint256) {
        return principalHighWaterMark;
    }

    /// @dev Simulate yield accrual: value appears without a deposit.
    function simulateYield() external payable {
        assets += msg.value;
    }

    /// @dev Simulate impermanent loss: reported value falls below principal.
    function simulateLoss(uint256 amount) external {
        assets = amount > assets ? 0 : assets - amount;
    }
}

/// @dev Stands in for Pons V2FeeEscrow: pull-based, pays msg.sender.
contract MockEscrow {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public balanceOfToken;

    receive() external payable {}

    /// @dev Credit a recipient, as the Pons fee sweep would.
    function credit(address to) external payable {
        balanceOf[to] += msg.value;
    }

    function creditToken(address to, address token, uint256 amount) external {
        balanceOfToken[to][token] += amount;
    }

    function claim() external returns (uint256) {
        uint256 amount = balanceOf[msg.sender];
        balanceOf[msg.sender] = 0;
        if (amount != 0) {
            (bool ok, ) = msg.sender.call{value: amount}("");
            require(ok, "MockEscrow: send failed");
        }
        return amount;
    }

    function claimToken(address token, uint256) external returns (uint256) {
        uint256 amount = balanceOfToken[msg.sender][token];
        balanceOfToken[msg.sender][token] = 0;
        if (amount != 0) ERC20(token).transfer(msg.sender, amount);
        return amount;
    }

    function claimToken(address token) external returns (uint256) {
        uint256 amount = balanceOfToken[msg.sender][token];
        balanceOfToken[msg.sender][token] = 0;
        if (amount != 0) ERC20(token).transfer(msg.sender, amount);
        return amount;
    }
}

/// @dev Stands in for the Pons bonding curve: only `deployer` may sweepFees.
contract MockCurve {
    address public deployer;
    uint256 public creatorTaxBalance;

    error NotDeployer();

    constructor(address deployer_) {
        deployer = deployer_;
    }

    receive() external payable {}

    /// @dev Accrue tax, as trading would.
    function accrue() external payable {
        creatorTaxBalance += msg.value;
    }

    function sweepFees(uint256 amount) external {
        if (msg.sender != deployer) revert NotDeployer();
        uint256 send = amount > creatorTaxBalance ? creatorTaxBalance : amount;
        creatorTaxBalance -= send;
        (bool ok, ) = msg.sender.call{value: send}("");
        require(ok, "MockCurve: send failed");
    }
}

/// @dev Stands in for the Suits SeaDrop ERC-721: fixed supply, NOT enumerable.

/// @dev Forwards ETH using `transfer()`, i.e. with only a 2300-gas stipend.
contract StipendSender {
    function send(address to, uint256 amount) external {
        payable(to).transfer(amount);
    }

    receive() external payable {}
}

/// @dev An adapter that always reverts on `totalAssets()`, to prove the
///      Treasury's dependence on well-behaved adapters is real and documented.
contract RevertingAdapter is IYieldAdapter {
    function deposit() external payable {}

    function withdraw(uint256) external pure returns (uint256) {
        return 0;
    }

    function realizeSurplus() external pure returns (uint256) {
        return 0;
    }

    function totalAssets() external pure returns (uint256) {
        revert("adapter down");
    }

    function principal() external pure returns (uint256) {
        revert("adapter down");
    }
}


/**
 * Tries to re-enter `claim()` from the ETH callback.
 *
 * The vault sends with `.call`, which forwards all gas, so `nonReentrant` is
 * the only thing standing between this and draining the reward pool.
 */
interface IStakedLoyal {
    function claim() external returns (uint256);
    function deposit(uint256 assets, address receiver) external returns (uint256);
}

contract ReentrantClaimer {
    IStakedLoyal public immutable vault;
    uint256 public reenteredTimes;
    bool private attacking;

    constructor(address vault_) {
        vault = IStakedLoyal(vault_);
    }

    function stake(address token, uint256 amount) external {
        IERC20(token).approve(address(vault), type(uint256).max);
        vault.deposit(amount, address(this));
    }

    function attack() external {
        attacking = true;
        vault.claim();
        attacking = false;
    }

    receive() external payable {
        if (!attacking) return;
        // One re-entry attempt is enough to prove the guard holds; swallowing
        // the revert keeps the outer claim succeeding so the test can assert on
        // the amount actually paid rather than on a bubbled failure.
        try vault.claim() {
            reenteredTimes++;
        } catch {}
    }
}


/// @dev Stands in for an eligibility gate: an allowlist nobody but the test sets.
contract MockGate {
    mapping(address => bool) public allowed;

    function allow(address who, bool ok) external {
        allowed[who] = ok;
    }

    function check(address account) external view returns (bool) {
        return allowed[account];
    }
}


/**
 * A team recipient that tries to re-enter `claimTeam()` from its ETH callback.
 *
 * Two things are supposed to stop it, and the test asserts the outcome rather
 * than which one fired: `pendingTeam` is zeroed before the transfer, so a
 * re-entry finds nothing to take, and `nonReentrant` refuses the call anyway.
 */
interface ITreasuryTeam {
    function claimTeam() external returns (uint256);
}

contract ReentrantTeam {
    ITreasuryTeam public immutable treasury;
    uint256 public reenteredTimes;
    uint256 public received;
    bool private attacking;

    constructor(address treasury_) {
        treasury = ITreasuryTeam(treasury_);
    }

    function attack() external {
        attacking = true;
        treasury.claimTeam();
        attacking = false;
    }

    receive() external payable {
        received += msg.value;
        if (!attacking) return;
        try treasury.claimTeam() {
            reenteredTimes++;
        } catch {}
    }
}


/// @dev Refuses ETH outright. Stands in for a team wallet that is a contract
///      with no payable path — the case that must not be able to brick `fund()`.
contract EthRejecter {
    // No receive, no fallback: every plain transfer to this address reverts.
}
