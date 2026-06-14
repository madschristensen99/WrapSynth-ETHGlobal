// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice Minimal surface of the wsXmrHub (LiquidationFacet) that this registry
///         depends on. Declared locally so the registry compiles independently
///         of the protocol's facet wiring.
/// @dev These are read-only on the facet, but the hub is a proxy whose fallback
///      writes EIP-1153 transient storage (TSTORE) on every routed call. TSTORE
///      reverts inside a STATICCALL, so we MUST invoke them via CALL — hence the
///      functions are intentionally NOT marked `view` here. (The state the hub
///      touches is transient and self-resets; flagging stays trust-minimized via
///      the on-chain re-validation below.)
interface IHubLiquidationView {
    function isVaultLiquidatable(address lpVault) external returns (bool);
    function calculateLiquidation(address lpVault, uint256 debtToClear)
        external
        returns (uint256 collateralSeized, uint256 actualDebtCleared);
}

/// @notice ERC-165 interface detection (used by the Chainlink KeystoneForwarder).
interface IERC165 {
    function supportsInterface(bytes4 interfaceId) external view returns (bool);
}

/// @notice Chainlink CRE consumer interface. The KeystoneForwarder delivers a
///         DON-signed report by calling onReport().
interface IReceiver is IERC165 {
    function onReport(bytes calldata metadata, bytes calldata report) external;
}

/**
 * @title LiquidationAlertRegistry
 * @notice Trustless, self-validating sink for the WrapSynth "CRE Liquidation
 *         Keeper" workflow. A Chainlink CRE workflow polls vault health with
 *         DON consensus and flags undercollateralized (<120% CR) vaults here.
 *         Independent liquidators / LPs watch for {VaultFlaggedForLiquidation}
 *         and then call `liquidate()` (burn wsXMR for the bonus) or
 *         `backstopVault()` (take the position over) on the hub.
 *
 * @dev Two delivery paths, both self-validating against the live hub:
 *      1. {onReport} — invoked by the Chainlink KeystoneForwarder with a
 *         DON-signed report that ABI-encodes `address[] vaults`.
 *      2. {flagVault} / {flagBatch} — fully permissionless, so anyone (a manual
 *         keeper, a test harness, or a fallback bot) can flag a vault.
 *
 *      In every path we re-check `isVaultLiquidatable(vault)` ON-CHAIN before
 *      emitting, so a flag can never be forged for a healthy vault regardless
 *      of who (or which DON) submitted it. This is why no forwarder allowlist
 *      is required for correctness; the optional `forwarder` lock only narrows
 *      who may use the {onReport} entrypoint.
 */
contract LiquidationAlertRegistry is IReceiver {
    // ========== STORAGE ==========

    /// @notice wsXmrHub address (LiquidationFacet view functions live here).
    address public immutable hub;

    /// @notice Contract owner (may update the forwarder lock).
    address public owner;

    /// @notice If non-zero, only this address (the Chainlink Forwarder) may
    ///         call {onReport}. address(0) leaves {onReport} open — acceptable
    ///         because flagging is self-validating.
    address public forwarder;

    /// @notice Monotonic counter of accepted flags (handy for off-chain indexing).
    uint256 public flagCount;

    // ========== EVENTS ==========

    /// @notice Emitted whenever a vault is confirmed undercollateralized and flagged.
    /// @param vault The undercollateralized LP vault.
    /// @param debt The vault's current wsXMR debt (8 decimals).
    /// @param flagger msg.sender that delivered the flag (forwarder or EOA).
    /// @param timestamp Block timestamp at flag time.
    event VaultFlaggedForLiquidation(
        address indexed vault,
        uint256 debt,
        address indexed flagger,
        uint256 timestamp
    );

    /// @notice Emitted (instead of reverting) when a submitted vault is not
    ///         actually liquidatable, so batch delivery never reverts wholesale.
    event VaultFlagRejected(address indexed vault, address indexed flagger);

    event ForwarderUpdated(address indexed previousForwarder, address indexed newForwarder);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    // ========== ERRORS ==========

    error ZeroHub();
    error NotOwner();
    error InvalidSender(address sender, address expected);
    error NothingToFlag();

    // ========== MODIFIERS ==========

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    // ========== CONSTRUCTOR ==========

    /// @param _hub wsXmrHub address exposing the LiquidationFacet view functions.
    /// @param _forwarder Chainlink Forwarder allowed to call {onReport}, or
    ///        address(0) to leave {onReport} permissionless.
    constructor(address _hub, address _forwarder) {
        if (_hub == address(0)) revert ZeroHub();
        hub = _hub;
        owner = msg.sender;
        forwarder = _forwarder;
        emit OwnershipTransferred(address(0), msg.sender);
        emit ForwarderUpdated(address(0), _forwarder);
    }

    // ========== CRE ENTRYPOINT ==========

    /// @inheritdoc IReceiver
    /// @dev `report` is `abi.encode(address[] vaults)`. `metadata` (workflow
    ///      identity) is ignored — trust comes from the on-chain re-validation,
    ///      not from the report's authorship.
    function onReport(bytes calldata, bytes calldata report) external override {
        if (forwarder != address(0) && msg.sender != forwarder) {
            revert InvalidSender(msg.sender, forwarder);
        }

        address[] memory vaults = abi.decode(report, (address[]));
        _flagMany(vaults);
    }

    // ========== PERMISSIONLESS ENTRYPOINTS ==========

    /// @notice Flag a single undercollateralized vault. Reverts only if the
    ///         vault is healthy (so honest callers get clear feedback).
    function flagVault(address vault) external {
        if (!_flagOne(vault)) revert NothingToFlag();
    }

    /// @notice Flag many vaults at once. Healthy entries are skipped (emit
    ///         {VaultFlagRejected}) rather than reverting the whole batch.
    function flagBatch(address[] calldata vaults) external {
        uint256 flagged = _flagMany(vaults);
        if (flagged == 0) revert NothingToFlag();
    }

    // ========== INTERNAL ==========

    function _flagMany(address[] memory vaults) internal returns (uint256 flagged) {
        for (uint256 i = 0; i < vaults.length; i++) {
            if (_flagOne(vaults[i])) {
                flagged++;
            } else {
                emit VaultFlagRejected(vaults[i], msg.sender);
            }
        }
    }

    function _flagOne(address vault) internal returns (bool) {
        if (vault == address(0)) return false;
        if (!IHubLiquidationView(hub).isVaultLiquidatable(vault)) return false;

        // type(uint256).max is capped to the vault's actual debt inside the hub,
        // so this returns the full outstanding debt for the alert payload.
        (, uint256 debt) = IHubLiquidationView(hub).calculateLiquidation(vault, type(uint256).max);

        unchecked {
            flagCount++;
        }
        emit VaultFlaggedForLiquidation(vault, debt, msg.sender, block.timestamp);
        return true;
    }

    // ========== ADMIN ==========

    function setForwarder(address _forwarder) external onlyOwner {
        emit ForwarderUpdated(forwarder, _forwarder);
        forwarder = _forwarder;
    }

    function transferOwnership(address newOwner) external onlyOwner {
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    // ========== ERC-165 ==========

    /// @inheritdoc IERC165
    function supportsInterface(bytes4 interfaceId) external pure override returns (bool) {
        return interfaceId == type(IReceiver).interfaceId || interfaceId == type(IERC165).interfaceId;
    }
}
