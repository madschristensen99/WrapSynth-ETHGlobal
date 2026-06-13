// SPDX-License-Identifier: LGPLv3
pragma solidity ^0.8.28;

import {SimpleOracleFacet} from "./SimpleOracleFacet.sol";

/**
 * @title RedStoneOracleFacet
 * @notice Stub for RedStoneOracleFacet to avoid compilation issues
 * @dev Use SimpleOracleFacet instead for testing
 */
contract RedStoneOracleFacet is SimpleOracleFacet {
    constructor(address _wsxmrToken, address _verifierProxy, address _collateralToken)
        SimpleOracleFacet(_wsxmrToken, _verifierProxy, _collateralToken, msg.sender)
    {}
}
